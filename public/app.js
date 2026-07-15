import { mountAtlas } from './atlas.js';

const app = document.querySelector('#app');
const header = document.querySelector('#site-header');
const nav = document.querySelector('#main-nav');
const navToggle = document.querySelector('#nav-toggle');
const motionToggle = document.querySelector('#motion-toggle');
const toastNode = document.querySelector('#toast');
let cleanup = () => {};
let toastTimer = 0;
const state = { meta: null, documents: [], insights: [], me: null };

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
  const [meta, docs, insights] = await Promise.all([
    api('/api/meta'), api('/api/documents?limit=200'), api('/api/insights'),
  ]);
  state.meta = meta;
  state.documents = docs.documents;
  state.insights = insights.insights;
}

async function loadMe() {
  if (!state.me) state.me = await api('/api/me').catch(() => ({ authenticated: false, user: null, admin: false }));
  return state.me;
}

function navigate(href, replace = false) {
  const url = new URL(href, location.origin);
  if (url.origin !== location.origin) { location.href = href; return; }
  history[replace ? 'replaceState' : 'pushState']({}, '', url.pathname + url.search);
  route();
}

function pageHero(label, title, description, aside = '') {
  return `<header class="page-hero"><div class="page-hero-inner"><div><span class="section-label">${escapeHtml(label)}</span><h1>${escapeHtml(title)}</h1></div><div><p>${escapeHtml(description)}</p>${aside}</div></div></header>`;
}

function chip(text, kind = '') { return `<span class="chip ${kind}">${escapeHtml(text)}</span>`; }

function verificationLabel(status) {
  const labels = {
    verified_exact: '同版精确核验',
    verified_stable_fact_only: '稳定事实已核验',
    version_variant_reference_only: '异版仅供参考',
    conflict_requires_review: '冲突待复核',
    human_judgment_with_warning: '人工判断·有疑点',
    unresolved_fail_closed: '未确认·禁止引文',
    exact_document_exact_edition: '同文同版',
    exact_document_revision_uncertain: '同文·版次存疑',
    same_work_different_edition: '同篇异版',
    stable_fact_only: '仅核稳定事实',
    not_matched: '未匹配',
  };
  return labels[status] || status;
}

function statusChip(status) {
  const map = {
    current_with_revision_watch: ['现行·修订观察', 'current'], current_reference: ['现行参考', 'current'],
    historical: ['历史资料', 'historical'], historical_reference: ['历史参考', 'historical'],
    superseded: ['已被后续版本替代', 'historical'], missing_primary_files: ['原件待补', 'historical'],
    revision_watch: ['修订动态', 'current'],
  };
  const [label, kind] = map[status] || [status, ''];
  return chip(label, kind);
}

function qualityChip(doc) {
  if (Number(doc.citation_allowed) === 1) return chip('可核验引文', 'current');
  if (String(doc.text_quality_status || '').startsWith('ocr')) return chip('OCR复核中', 'historical');
  return chip('元数据/待核', 'historical');
}

function documentCard(doc) {
  return `<a class="document-card" href="/document/${encodeURIComponent(doc.id)}" data-link>
    <div class="doc-meta">${chip(doc.subject)}${chip(doc.stage)}${statusChip(doc.current_status)}${qualityChip(doc)}</div>
    <h3>${escapeHtml(doc.title)}</h3>
    <p>${escapeHtml(doc.issued_by)}${doc.issued_date ? ` · ${escapeHtml(doc.issued_date)}` : ''}</p>
    <span class="doc-link">查看原文索引与引文 →</span>
  </a>`;
}

function homePage() {
  const recent = state.documents.filter((doc) => doc.current_status.startsWith('current')).slice(0, 6);
  const periodCards = state.meta.periods.map((period) => `<article class="era-card"><time>${period.start_year}—${period.end_year || '至今'}</time><h3>${escapeHtml(period.label)}</h3><p>${escapeHtml(period.summary)}</p></article>`).join('');
  const insightCards = state.insights.slice(0, 6).map((item, index) => `<article class="insight-card" data-index="${String(index + 1).padStart(2, '0')}"><span class="chip">${escapeHtml(item.era)}</span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.summary)}</p></article>`).join('');
  app.innerHTML = `<section class="hero">
    <canvas class="atlas-canvas" aria-label="课程标准年代与学科关系星图；可拖动、缩放并点击节点"></canvas>
    <div class="atlas-tip"></div>
    <div class="hero-copy"><p class="eyebrow">Teacher research atlas · 1950—today</p><h1>课程标准<em>如何改变课堂</em></h1>
      <p class="hero-lede">把分散在年代、学段和学科中的国家课程文件重新连成一张可核查的图：每个判断回到官方原文，每次比较保留证据边界。</p>
      <div class="hero-actions"><a class="button primary" href="/timeline" data-link>进入演变时间轴</a><a class="button ghost" href="/sources" data-link>检索 ${state.meta.counts.documents} 份资料</a></div>
    </div>
    <div class="atlas-legend"><span>课程标准 / 方案</span><span>考试评价 / 政策</span><span>拖动 · 滚轮缩放 · 点击阅读</span></div>
  </section>
  <section class="section paper"><div class="section-head"><div><span class="section-label">Evidence first</span><h2>不是年表陈列，<br>而是证据结构</h2></div><p>资料、版本、概念、评价要求与教师讨论共享稳定编号。历史原件未找到时明确留空，不让二手描述冒充原文。</p></div>
    <div class="metric-strip"><div class="metric"><strong>${state.meta.counts.documents}</strong><span>份编目资料</span></div><div class="metric"><strong>${state.meta.counts.citationReadyDocuments}</strong><span>份引文就绪资料</span></div><div class="metric"><strong>${state.meta.counts.onlineVerifications}</strong><span>项在线三证核查</span></div></div>
  </section>
  <section class="section white"><div class="section-head"><div><span class="section-label">Five movements</span><h2>五次结构变化</h2></div><p>年份只是坐标。真正需要观察的是育人目标、课程内容、学习任务、学业要求和评价方式如何被重新连接。</p></div><div class="era-grid">${periodCards}</div></section>
  <section class="section paper"><div class="section-head"><div><span class="section-label">Editorial findings</span><h2>先看变化，<br>再回到原文</h2></div><p>编辑结论只承担导航作用；每张卡的证据编号均可回到对应官方文件，AI 也不能越过这一层。</p></div><div class="content-max insight-grid">${insightCards}</div></section>
  <section class="section night"><div class="section-head"><div><span class="section-label">Current baseline</span><h2>现行基线与修订观察</h2></div><p>义务教育 2022 年版、普通高中 2017 年版 2020 年修订目前作为公开目录基线；修订工作动态不等于新标准已发布。</p></div><div class="content-max document-grid">${recent.map(documentCard).join('')}</div></section>`;
  cleanup = mountAtlas(document.querySelector('.atlas-canvas'), state.documents, (doc) => navigate(`/document/${doc.id}`));
}

function timelinePage() {
  const events = [
    [1950, '课程标准的国家起点', '教育部官方沿革把 1950 年课程标准列为新中国基础教育课程建设起点；原件尚未取得的科目保持“待补”。'],
    [1956, '统一教学大纲体系形成', '课程文件逐步以教学大纲组织，强调统一教学要求。'],
    [1986, '义务教育制度化', '九年义务教育制度建设推动课程计划与分科教学大纲调整。'],
    [1992, '九年义务教育课程计划与大纲', '义务教育课程结构进入相对完整的国家统一框架。'],
    [2001, '基础教育新课程改革', '课程标准实验以学生发展、学习方式转变和三级课程管理重构传统教学大纲逻辑。'],
    [2003, '普通高中新课程实验', '高中课程以领域、科目、模块组织，选修与学分制度成为显著结构变化。'],
    [2011, '义务教育课程标准修订', '19 个分科标准形成可直接核验的历史横截面。'],
    [2017, '高中核心素养与学业质量', '普通高中课程标准用核心素养统摄目标，并增加学业质量标准。'],
    [2020, '高中标准修订与高考评价体系', '高中标准完成 2020 年修订；高考评价体系提供命题评价的上位框架。'],
    [2022, '义务教育课程方案与标准重构', '课程方案与 16 个课程标准强化核心素养、课程内容结构化、学业质量和教—学—评一致性。'],
  ];
  const rows = events.map(([year, title, summary]) => {
    const docs = state.documents.filter((doc) => doc.sort_year === year).slice(0, 8);
    return `<article class="timeline-row"><div class="timeline-year">${year}</div><div class="timeline-content"><h2>${title}</h2><p>${summary}</p><div class="timeline-docs">${docs.map((doc) => `<a class="chip" href="/document/${doc.id}" data-link>${escapeHtml(doc.subject)}</a>`).join('')}</div></div></article>`;
  }).join('');
  app.innerHTML = `<div class="page">${pageHero('Chronology', '国家课程文件的结构演变', '时间轴中的历史节点来自教育部官方沿革、正式发布通知和已核验附件；未取得原件的早期版本不生成伪引文。')}<section class="section paper"><div class="timeline">${rows}</div></section></div>`;
}

function subjectsPage(url) {
  const selected = url.searchParams.get('subject') || '';
  const subjects = state.meta.subjects.map((item) => item.name).filter((name) => !['综合', '考试评价'].includes(name));
  const docs = selected ? state.documents.filter((doc) => doc.subject === selected) : [];
  const subjectInsights = selected ? state.insights.filter((item) => item.subject === selected || item.subject === '综合') : [];
  app.innerHTML = `<div class="page">${pageHero('Subject lenses', selected || '分学科观察课程变化', selected ? `把 ${selected} 的不同版本放回共同的目标—内容—任务—要求—评价框架中。` : '选择一个学科，查看版本序列、编辑结论和原文入口；不同学段同名学科仍保留各自文件边界。')}
    <section class="section paper"><div class="content-max"><div class="chip-row">${subjects.map((name) => `<a class="chip ${name === selected ? 'current' : ''}" href="/subjects?subject=${encodeURIComponent(name)}" data-link>${escapeHtml(name)}</a>`).join('')}</div>
      ${selected ? `<div class="insight-grid">${subjectInsights.map((item, index) => `<article class="insight-card" data-index="${String(index + 1).padStart(2, '0')}"><span class="chip">${escapeHtml(item.dimension)}</span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.summary)}</p></article>`).join('') || '<div class="empty">该学科的结构化比较仍在编辑复核中，可先阅读版本原文。</div>'}</div><h2 style="margin-top:56px;font-family:var(--serif)">版本资料</h2><div class="document-grid">${docs.map(documentCard).join('')}</div>` : '<div class="empty">从上方选择学科开始。</div>'}
    </div></section></div>`;
}

function sourcesPage(url) {
  const subject = url.searchParams.get('subject') || '';
  const type = url.searchParams.get('type') || '';
  const query = (url.searchParams.get('q') || '').trim();
  let docs = state.documents;
  if (subject) docs = docs.filter((doc) => doc.subject === subject);
  if (type) docs = docs.filter((doc) => doc.document_type === type);
  if (query) docs = docs.filter((doc) => `${doc.title}${doc.subject}${doc.issued_by}`.includes(query));
  const subjects = [...new Set(state.documents.map((doc) => doc.subject))].sort();
  const types = [...new Set(state.documents.map((doc) => doc.document_type))].sort();
  app.innerHTML = `<div class="page">${pageHero('Source library', '官方资料库', '首发资料覆盖现行与历史课程方案、课程标准、2019 高考考试大纲及改革政策。文件下载始终指向官方发布机构；本站不替换原始版本。', '<p class="status-note">检索段落共 '+state.meta.counts.paragraphs.toLocaleString('zh-CN')+' 条；早期原件缺口公开标注。</p>')}
    <section class="section paper"><div class="content-max"><form class="filters" id="source-filter"><input name="q" value="${escapeHtml(query)}" placeholder="按标题、学科或发布机构筛选"><select name="subject"><option value="">全部学科</option>${subjects.map((name) => `<option ${name === subject ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select><select name="type"><option value="">全部类型</option>${types.map((name) => `<option ${name === type ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select><button class="button" type="submit">筛选</button><a class="button light" href="/search" data-link>检索原文</a></form>
      <p class="source-line">显示 ${docs.length} / ${state.documents.length} 份资料</p><div class="document-grid">${docs.map(documentCard).join('')}</div></div></section></div>`;
  document.querySelector('#source-filter').addEventListener('submit', (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); navigate(`/sources?${new URLSearchParams(data).toString()}`); });
}

function searchPage(url) {
  const query = url.searchParams.get('q') || '';
  const subject = url.searchParams.get('subject') || '';
  const subjects = [...new Set(state.documents.map((doc) => doc.subject))].sort();
  app.innerHTML = `<div class="page">${pageHero('Full-text evidence', '检索原文段落', '搜索结果直接返回官方文件中的可定位段落；短关键词使用保守回退，不生成语义猜测。')}<section class="section paper"><div class="content-max"><form class="filters" id="search-form"><input name="q" value="${escapeHtml(query)}" placeholder="例如：学业质量、学习任务群、过程性评价" required minlength="2"><select name="subject"><option value="">全部学科</option>${subjects.map((name) => `<option ${name === subject ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select><button class="button" type="submit">检索</button></form><div class="search-results" id="search-results">${query ? '<div class="empty">正在检索原文…</div>' : '<div class="empty">输入概念、条文片段或教学评价关键词。</div>'}</div></div></section></div>`;
  const form = document.querySelector('#search-form');
  form.addEventListener('submit', (event) => { event.preventDefault(); const data = new FormData(form); navigate(`/search?${new URLSearchParams(data).toString()}`); });
  if (query) runSearch(query, subject);
}

async function runSearch(query, subject) {
  const root = document.querySelector('#search-results');
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(query)}&subject=${encodeURIComponent(subject)}`);
    root.innerHTML = data.passages.length ? data.passages.map((item) => `<article class="passage"><h3><a href="/document/${item.document_id}" data-link>${escapeHtml(item.title)}</a></h3><p class="source-line">${escapeHtml(item.subject)} · ${escapeHtml(item.source_locator)}</p><p>${highlight(item.body, query)}</p></article>`).join('') : '<div class="empty">没有找到包含该词组的原文段落。</div>';
  } catch (error) { root.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}

function highlight(body, query) {
  const safe = escapeHtml(body);
  const needle = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return needle ? safe.replace(new RegExp(needle, 'gi'), (match) => `<mark>${match}</mark>`) : safe;
}

function comparePage(url) {
  const subject = url.searchParams.get('subject') || '语文';
  const subjects = [...new Set(state.documents.map((doc) => doc.subject))].filter((name) => state.documents.filter((doc) => doc.subject === name).length > 1).sort();
  app.innerHTML = `<div class="page">${pageHero('Version comparison', '比较版本，不消灭语境', '比较列先呈现文件年代、学段、状态和来源。编辑结论与原文分开，避免把关键词差异误当成政策因果。')}<section class="section paper"><div class="content-max compare-layout"><aside class="panel sticky-panel"><label for="compare-subject">选择学科</label><select id="compare-subject">${subjects.map((name) => `<option ${name === subject ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select><p class="source-line">不同学段并列时请先确认适用范围。</p></aside><div id="comparison"><div class="empty">正在载入版本序列…</div></div></div></section></div>`;
  document.querySelector('#compare-subject').addEventListener('change', (event) => navigate(`/compare?subject=${encodeURIComponent(event.target.value)}`));
  api(`/api/compare?subject=${encodeURIComponent(subject)}`).then((data) => {
    document.querySelector('#comparison').innerHTML = `<h2 style="font-family:var(--serif)">${escapeHtml(subject)}版本序列</h2><div class="comparison-track">${data.documents.map((doc) => `<article class="version-column"><time>${doc.sort_year || '待考'}</time><h3>${escapeHtml(doc.version_label)}</h3><p>${escapeHtml(doc.stage)}</p>${statusChip(doc.current_status)}<p><a href="/document/${doc.id}" data-link>阅读原文索引 →</a></p></article>`).join('')}</div><div class="insight-grid" style="margin-top:24px">${data.insights.map((item, index) => `<article class="insight-card" data-index="${String(index + 1).padStart(2, '0')}"><span class="chip">${escapeHtml(item.dimension)}</span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.summary)}</p></article>`).join('')}</div>`;
  }).catch((error) => { document.querySelector('#comparison').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; });
}

async function termsPage() {
  const data = await api('/api/terms');
  const width = 900, height = 420;
  const nodes = data.terms.map((term, index) => ({ ...term, x: 120 + (index % 3) * 330, y: 90 + Math.floor(index / 3) * 170 }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const lines = data.relations.map((edge) => { const a = byId.get(edge.source_term_id), b = byId.get(edge.target_term_id); return a && b ? `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="rgba(120,216,255,.35)" stroke-width="${edge.weight * 2}"/><text x="${(a.x+b.x)/2}" y="${(a.y+b.y)/2-8}" fill="rgba(255,255,255,.55)" font-size="11" text-anchor="middle">${escapeHtml(edge.relation_type)}</text>` : ''; }).join('');
  const circles = nodes.map((node) => `<g><circle cx="${node.x}" cy="${node.y}" r="48" fill="#172c56" stroke="#e7b75f"/><text x="${node.x}" y="${node.y+5}" fill="#fffdf8" text-anchor="middle" font-size="15">${escapeHtml(node.label)}</text></g>`).join('');
  app.innerHTML = `<div class="page">${pageHero('Concept relations', '概念不是口号，而是结构', '把三维目标、核心素养、学业质量、学习任务群与教—学—评一致性放入证据关系中，观察它们如何承接、落实或约束彼此。')}<section class="section paper"><div class="content-max"><div class="term-map" role="img" aria-label="课程概念关系图"><svg viewBox="0 0 ${width} ${height}">${lines}${circles}</svg></div><div class="term-list">${data.terms.map((term) => `<article class="term-card"><span class="chip">${escapeHtml(term.category)}</span><h3>${escapeHtml(term.label)}</h3><p>${escapeHtml(term.definition)}</p><p class="source-line">首次进入本资料序列：${term.first_seen_year || '待考'}</p></article>`).join('')}</div></div></section></div>`;
}

async function documentPage(id) {
  const data = await api(`/api/documents/${encodeURIComponent(id)}?limit=200`);
  const doc = data.document;
  const source = `<a class="button light" href="${escapeHtml(doc.source_url)}" target="_blank" rel="noopener">打开官方原件 ↗</a>`;
  const qualityNote = Number(doc.citation_allowed) === 1
    ? '正文已进入引文白名单；仍应按页码回看官方原件。'
    : String(doc.text_quality_status || '').startsWith('ocr')
      ? '扫描件正在逐页执行“图像—多引擎OCR—版本感知在线文本”三证核查；未通过页面不会进入AI引文。'
      : '当前仅开放资料身份或未核验文本，不生成精确引文。';
  const verificationCards = data.verifications.map((item) => `<article class="verification-card ${item.uncertainty_note ? 'uncertain' : ''}">
    <div class="chip-row">${chip(verificationLabel(item.verification_status))}${chip(verificationLabel(item.edition_match_status))}</div>
    <h4>${escapeHtml(item.entity_label)}</h4>
    <p>${escapeHtml(item.resolution)}</p>
    ${item.uncertainty_note ? `<p class="uncertainty-note">可能有问题：${escapeHtml(item.uncertainty_note)}</p>` : ''}
    <p class="source-line">PDF 第 ${item.physical_page || '待定'} 页${item.printed_page ? ` · 印刷页 ${escapeHtml(item.printed_page)}` : ''}</p>
    <ul class="evidence-list">${item.evidence.map((evidence) => `<li><a href="${escapeHtml(evidence.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(evidence.publisher)}</a><span>${escapeHtml(verificationLabel(evidence.versionMatch))} · ${escapeHtml(evidence.factSummary)}</span></li>`).join('')}</ul>
  </article>`).join('');
  const paragraphs = data.paragraphs.length
    ? data.paragraphs.map((paragraph) => `<section class="paragraph ${paragraph.uncertainty_note ? 'uncertain' : ''}" id="p-${paragraph.id}"><span class="paragraph-number">P:${paragraph.id}<br>${escapeHtml(paragraph.source_locator)}</span>${escapeHtml(paragraph.body)}${paragraph.uncertainty_note ? `<small class="uncertainty-note">可能有问题：${escapeHtml(paragraph.uncertainty_note)}</small>` : ''}</section>`).join('')
    : `<div class="empty">${verificationCards ? '整份正文尚未开放；下列已核验片段可独立查看证据链。' : '该记录目前只有元数据，未取得可核验原文。'}</div>`;
  app.innerHTML = `<div class="page">${pageHero(doc.subject, doc.title, `${doc.issued_by}${doc.issued_date ? ` · ${doc.issued_date}` : ''}`, `<div class="chip-row">${chip(doc.stage)}${chip(doc.document_type)}${statusChip(doc.current_status)}${qualityChip(doc)}</div>`)}<section class="section paper"><div class="content-max reader-layout"><article class="reader-paper"><p class="status-note">${escapeHtml(qualityNote)}</p>${paragraphs}${verificationCards ? `<section class="verification-section"><h2>在线三证核查</h2><p>在线来源只有在版次边界明确时才校正文句；新版只能旁证跨版本稳定事实。</p>${verificationCards}</section>` : ''}</article><aside class="reader-side"><div class="panel"><h3>资料身份</h3><p class="source-line">编号 ${escapeHtml(doc.id)}</p><p>版本：${escapeHtml(doc.version_label)}<br>状态：${escapeHtml(doc.current_status)}<br>文本质量：${escapeHtml(doc.text_quality_status || '待评估')}<br>页数：${doc.page_count || '待核'}<br>校验：${doc.checksum_sha256 ? escapeHtml(doc.checksum_sha256.slice(0, 16))+'…' : 'HTML/目录记录'}</p>${source}</div><div class="panel"><h3>研究入口</h3><p><a href="/search?q=${encodeURIComponent(doc.subject)}" data-link>检索同学科原文</a></p><p><a href="/compare?subject=${encodeURIComponent(doc.subject)}" data-link>比较版本</a></p><p><a href="/discussions?documentId=${encodeURIComponent(doc.id)}" data-link>围绕本资料讨论</a></p></div></aside></div></section></div>`;
}

async function aiPage() {
  const me = await loadMe();
  const subjects = [...new Set(state.documents.map((doc) => doc.subject))].sort();
  const aside = me.authenticated ? `<p class="status-note">已登录：${escapeHtml(me.user.display_name || me.user.slug)}。成功研究会写入统一用户中心事件，不保存原始问题文本。</p>` : '<p class="status-note">AI 研究需统一登录；全文检索始终公开。</p>';
  app.innerHTML = `<div class="page">${pageHero('Citation-locked RAG', '只在证据范围内回答', 'AI 先从官方文本中检索段落，再生成带 [P:编号] 的回答。若引文编号不属于本轮检索，整条回答会被拒绝。', aside)}<section class="section paper"><div class="content-max">${me.authenticated ? `<div class="ai-layout"><div><form class="panel" id="ai-form"><div class="field"><label for="ai-query">教师研究问题</label><textarea id="ai-query" name="query" rows="5" minlength="8" required placeholder="例如：义务教育语文从2011版到2022版，课程内容组织方式发生了哪些可核验变化？"></textarea></div><div class="form-row"><select name="subject"><option value="">跨学科</option>${subjects.map((name) => `<option>${escapeHtml(name)}</option>`).join('')}</select><button class="button" type="submit">检索并回答</button></div></form><div class="ai-answer" id="ai-answer">回答将在这里出现；所有事实引文都必须能回到本站段落编号。</div></div><aside><h2 style="font-family:var(--serif)">引文证据</h2><div id="ai-citations"><div class="empty">尚未提问</div></div></aside></div>` : `<div class="login-callout"><h2>先建立可追踪的研究会话</h2><p>统一登录用于控制 AI 成本、记录有意义的教师研究事件，并保持各 BDFZ 产品的一致身份。</p><a class="button primary" href="https://my.bdfz.net/?returnTo=${encodeURIComponent(location.href)}">前往统一用户中心登录</a><a class="button ghost" href="/search" data-link>先使用公开全文检索</a></div>`}</div></section></div>`;
  if (me.authenticated) document.querySelector('#ai-form').addEventListener('submit', submitAi);
}

async function submitAi(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  const answer = document.querySelector('#ai-answer');
  button.disabled = true;
  answer.textContent = '正在检索官方段落并校验引文…';
  try {
    const payload = Object.fromEntries(new FormData(form));
    const data = await api('/api/ai/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    answer.textContent = data.answer;
    const citations = document.querySelector('#ai-citations');
    citations.replaceChildren(...data.citations.map((citation) => {
      const card = document.createElement('article'); card.className = 'citation-card';
      const link = document.createElement('a'); link.href = `/document/${citation.documentId}#p-${citation.paragraphId}`; link.dataset.link = ''; link.textContent = `[P:${citation.paragraphId}] ${citation.title}`;
      const meta = document.createElement('small'); meta.textContent = `${citation.subject} · ${citation.locator}`;
      const excerpt = document.createElement('p'); excerpt.textContent = citation.excerpt;
      card.append(link, document.createElement('br'), meta, excerpt); return card;
    }));
    window.BdfzIdentity?.recordEvent?.({ siteKey: 'curriculum', recordKey: `ai-research:${Date.now()}`, title: '课程标准证据研究', summary: '完成一次带引文的课程标准研究', itemGroup: 'teacher-research', itemType: 'rag-query', contentFormat: 'curriculum-atlas-rag-v1', sourceUrl: location.href, payload: { eventName: 'ai_evidence_research', subject: payload.subject || 'cross-subject', retrievalCount: data.retrievalCount } }).catch(() => {});
  } catch (error) { answer.textContent = error.message; toast(error.message); }
  finally { button.disabled = false; }
}

async function discussionsPage(url) {
  const me = await loadMe();
  const documentId = url.searchParams.get('documentId') || state.documents[0]?.id || '';
  const docs = state.documents.filter((doc) => doc.access_status !== 'metadata_only');
  app.innerHTML = `<div class="page">${pageHero('Teacher discussion', '把判断放回共同证据', '讨论可以引用整份资料或具体段落。统一登录内容直接公开；匿名内容需 Turnstile 并经审核，不采集原始 IP。')}<section class="section paper"><div class="content-max"><div class="form-row"><div class="panel"><label for="discussion-doc">讨论资料</label><select id="discussion-doc">${docs.map((doc) => `<option value="${doc.id}" ${doc.id === documentId ? 'selected' : ''}>${escapeHtml(doc.title)}</option>`).join('')}</select><div class="comments" id="comments" style="margin-top:18px"><div class="empty">正在加载讨论…</div></div></div><form class="panel comment-form" id="comment-form"><h2 style="margin:0;font-family:var(--serif)">提交讨论</h2>${me.authenticated ? `<p class="status-note">以 ${escapeHtml(me.user.display_name || me.user.slug)} 发布。</p>` : '<div class="field"><label for="author-name">署名（可用教研组/匿名教师）</label><input id="author-name" name="authorName" maxlength="40" value="匿名教师"></div>'}<div class="field"><label for="comment-body">内容</label><textarea id="comment-body" name="body" rows="7" minlength="8" maxlength="2000" required placeholder="请说明引用的版本、条文或课堂情境；不要写入学生个人信息。"></textarea></div><div id="turnstile-box"></div><button class="button" type="submit">${me.authenticated ? '发布讨论' : '提交审核'}</button></form></div></div></section></div>`;
  const select = document.querySelector('#discussion-doc');
  select.addEventListener('change', () => navigate(`/discussions?documentId=${encodeURIComponent(select.value)}`));
  loadComments(documentId);
  let turnstileToken = '';
  if (!me.authenticated) setupTurnstile(document.querySelector('#turnstile-box'), (token) => { turnstileToken = token; });
  document.querySelector('#comment-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true;
    try { const body = Object.fromEntries(new FormData(form)); body.documentId = documentId; body.turnstileToken = turnstileToken; const result = await api('/api/comments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); toast(result.message); form.reset(); if (result.status === 'approved') loadComments(documentId); else window.turnstile?.reset(); }
    catch (error) { toast(error.message); window.turnstile?.reset(); }
    finally { button.disabled = false; }
  });
}

async function loadComments(documentId) {
  const root = document.querySelector('#comments');
  try {
    const data = await api(`/api/comments?documentId=${encodeURIComponent(documentId)}`);
    root.replaceChildren();
    if (!data.comments.length) { root.innerHTML = '<div class="empty">尚无公开讨论。你可以留下第一条有证据的判断。</div>'; return; }
    for (const item of data.comments) {
      const article = document.createElement('article'); article.className = 'comment';
      const head = document.createElement('header'); const name = document.createElement('b'); name.textContent = item.author_name; const time = document.createElement('time'); time.textContent = new Date(item.created_at + 'Z').toLocaleString('zh-CN'); head.append(name, time);
      const body = document.createElement('p'); body.textContent = item.body; article.append(head, body); root.append(article);
    }
  } catch (error) { root.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}

function setupTurnstile(container, callback) {
  if (!state.meta.turnstileSiteKey) { container.innerHTML = '<p class="status-note">匿名讨论尚未配置。</p>'; return; }
  const render = () => window.turnstile.render(container, { sitekey: state.meta.turnstileSiteKey, callback, 'expired-callback': () => callback('') });
  if (window.turnstile) { render(); return; }
  const script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true; script.onload = render; document.head.append(script);
}

async function adminPage() {
  const me = await loadMe();
  app.innerHTML = `<div class="page">${pageHero('Operations', '内容管理与审计', '管理权限只由 Worker 服务端白名单判定；前端显示不构成授权。')}<section class="section paper"><div class="content-max" id="admin-root">${me.admin ? '<div class="empty">正在加载审核队列…</div>' : '<div class="login-callout"><h2>无管理权限</h2><p>请使用已配置的内容管理员账号登录。普通登录用户不会自动成为管理员。</p></div>'}</div></section></div>`;
  if (!me.admin) return;
  try {
    const [summary, comments] = await Promise.all([api('/api/admin/summary'), api('/api/comments?moderation=1')]);
    document.querySelector('#admin-root').innerHTML = `<div class="metric-strip"><div class="metric"><strong>${summary.pending.count || 0}</strong><span>待审核讨论</span></div><div class="metric"><strong>${summary.reports.count || 0}</strong><span>开放举报</span></div><div class="metric"><strong>${summary.aiFailures.count || 0}</strong><span>7日 AI 引文失败</span></div></div><div class="comments" style="margin-top:28px">${comments.comments.filter((item) => item.status === 'pending').map((item) => `<article class="comment"><header><b>${escapeHtml(item.author_name)}</b><time>${escapeHtml(item.created_at)}</time></header><p>${escapeHtml(item.body)}</p><div class="chip-row"><button class="button" data-moderate="approved" data-id="${item.id}">通过</button><button class="button danger" data-moderate="rejected" data-id="${item.id}">拒绝</button></div></article>`).join('') || '<div class="empty">当前没有待审核讨论。</div>'}</div>`;
    document.querySelectorAll('[data-moderate]').forEach((button) => button.addEventListener('click', async () => { try { await api(`/api/admin/comments/${button.dataset.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: button.dataset.moderate }) }); toast('审核状态已更新'); adminPage(); } catch (error) { toast(error.message); } }));
  } catch (error) { document.querySelector('#admin-root').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; }
}

async function route() {
  cleanup(); cleanup = () => {};
  nav.classList.remove('open'); navToggle.setAttribute('aria-expanded', 'false');
  window.scrollTo({ top: 0, behavior: 'instant' });
  const url = new URL(location.href);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  header.classList.toggle('paper', path !== '/');
  document.querySelectorAll('.main-nav a').forEach((link) => link.classList.toggle('active', link.getAttribute('href') === path));
  app.innerHTML = '<div class="loading-screen"><span class="orbit-loader"></span><p>正在校准资料星图…</p></div>';
  try {
    await loadBase();
    if (path === '/') homePage();
    else if (path === '/timeline') timelinePage();
    else if (path === '/subjects') subjectsPage(url);
    else if (path === '/sources') sourcesPage(url);
    else if (path === '/search') searchPage(url);
    else if (path === '/compare') comparePage(url);
    else if (path === '/terms') await termsPage();
    else if (path === '/ai') await aiPage();
    else if (path === '/discussions') await discussionsPage(url);
    else if (path === '/admin') await adminPage();
    else if (path.startsWith('/document/')) await documentPage(decodeURIComponent(path.slice('/document/'.length)));
    else app.innerHTML = `<div class="page">${pageHero('404', '没有这条路径', '资料编号可能已更正，或链接并不属于本站。')}<section class="section paper"><a class="button" href="/" data-link>返回星图</a></section></div>`;
  } catch (error) {
    app.innerHTML = `<div class="page">${pageHero('Service notice', '资料暂时无法载入', error.message)}<section class="section paper"><button class="button" id="retry">重试</button></section></div>`;
    document.querySelector('#retry')?.addEventListener('click', () => { state.meta = null; route(); });
  }
  app.focus({ preventScroll: true });
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-link]');
  if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey || link.target === '_blank') return;
  const target = new URL(link.href, location.origin);
  if (target.origin !== location.origin) return;
  event.preventDefault(); navigate(target.pathname + target.search + target.hash);
});
window.addEventListener('popstate', route);
navToggle.addEventListener('click', () => { const open = nav.classList.toggle('open'); navToggle.setAttribute('aria-expanded', String(open)); });
const stable = localStorage.getItem('curriculum:stable') === '1';
document.body.classList.toggle('stable', stable); motionToggle.setAttribute('aria-pressed', String(stable));
motionToggle.addEventListener('click', () => { const enabled = !document.body.classList.contains('stable'); document.body.classList.toggle('stable', enabled); motionToggle.setAttribute('aria-pressed', String(enabled)); localStorage.setItem('curriculum:stable', enabled ? '1' : '0'); route(); });
route();
