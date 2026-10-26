// curriculum.bdfz.net client. Pages are pre-rendered; this module only adds filtering,
// tabs and the views that need the API (full text, search, AI research, discussion).
// Nothing here calls /api/* on page load except those views.
const CATALOG_URL = '__CATALOG_URL__';
const HISTORICAL_URL = '__HISTORICAL_URL__';
const THEME_KEY = 'curriculum-atlas-theme-v1';
const LOGIN_URL = 'https://my.bdfz.net/';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const h = escapeHtml;

// ---------- shared integrations (unchanged contract: site-auth + Pulse) ----------

function loadProductionIntegrations() {
  if (location.hostname !== 'curriculum.bdfz.net') return;
  for (const integration of [
    { src: 'https://my.bdfz.net/site-auth.js', data: { siteKey: 'curriculum', mobileInsetBottom: '16' } },
    { src: 'https://pulse.bdfz.net/beacon.js', data: { site: 'curriculum.bdfz.net' } },
  ]) {
    const script = document.createElement('script');
    script.src = integration.src;
    script.async = true;
    Object.assign(script.dataset, integration.data);
    document.head.append(script);
  }
}

// ---------- theme ----------

function setupTheme() {
  const button = $('[data-theme-toggle]');
  if (!button) return;
  const sync = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    button.setAttribute('aria-pressed', String(dark));
    button.title = dark ? '切换为浅色' : '切换为深色';
    $('meta[name="theme-color"]')?.setAttribute('content', dark ? '#141619' : '#f7f5ef');
  };
  button.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable */ }
    sync();
  });
  sync();
}

// Close the subject menu when clicking elsewhere or pressing Escape.
function setupMenu() {
  const menu = $('.menu details');
  if (!menu) return;
  document.addEventListener('click', (event) => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.open) {
      menu.open = false;
      $('summary', menu).focus();
    }
  });
}

// ---------- home: whole-person aims ----------

function setupAims() {
  const tabs = $$('[data-region-tab]');
  if (!tabs.length) return;
  const show = (id) => {
    tabs.forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.regionTab === id)));
    $$('[data-region]').forEach((region) => {
      region.removeAttribute('data-region-hidden');
      region.hidden = region.dataset.region !== id;
    });
  };
  tabs.forEach((tab) => tab.addEventListener('click', () => show(tab.dataset.regionTab)));
  show(tabs[0].dataset.regionTab);
  $$('[data-aim-link]').forEach((link) => link.addEventListener('click', (event) => {
    const card = document.getElementById(link.dataset.aimLink);
    if (!card) return;
    event.preventDefault();
    card.open = true;
    card.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    $('summary', card).focus();
    history.replaceState(null, '', `#${card.id}`);
  }));
  if (location.hash.startsWith('#aim-') || location.hash.startsWith('#tw-aim-')) {
    const card = document.getElementById(location.hash.slice(1));
    if (card) {
      const region = card.closest('[data-region]');
      if (region) show(region.dataset.region);
      card.open = true;
    }
  }
}

// ---------- subject: filters ----------

function setupFilters() {
  const root = $('.subject-page');
  const rows = $$('.timeline .row', root || document);
  if (!root || !rows.length) return;
  const active = { stage: new Set(), type: new Set(), lang: new Set() };
  const text = $('[data-filter-text]', root);
  const count = $('[data-filter-count]', root);
  const empty = $('[data-filter-empty]', root);
  const apply = () => {
    const needle = (text?.value || '').trim();
    let visible = 0;
    for (const row of rows) {
      const ok = (!active.stage.size || active.stage.has(row.dataset.stage))
        && (!active.type.size || active.type.has(row.dataset.type))
        && (!active.lang.size || !row.dataset.lang || active.lang.has(row.dataset.lang))
        && (!needle || row.dataset.text.includes(needle));
      row.hidden = !ok;
      if (ok) visible += 1;
    }
    $$('.era', root).forEach((era) => { era.hidden = !$$('.row', era).some((row) => !row.hidden); });
    if (count) count.textContent = `${visible} / ${rows.length}`;
    if (empty) empty.hidden = visible > 0;
  };
  $$('[data-filter]', root).forEach((chip) => chip.addEventListener('click', () => {
    const set = active[chip.dataset.filter];
    const on = chip.getAttribute('aria-pressed') !== 'true';
    chip.setAttribute('aria-pressed', String(on));
    if (on) set.add(chip.dataset.value); else set.delete(chip.dataset.value);
    apply();
  }));
  text?.addEventListener('input', apply);
  apply();
}

// ---------- API helpers ----------

async function api(pathname, options) {
  const response = await fetch(pathname, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

let mePromise = null;
const loadMe = () => {
  mePromise ||= api('/api/me').catch(() => ({ authenticated: false, user: null, admin: false }));
  return mePromise;
};
let catalogPromise = null;
const loadCatalog = () => {
  catalogPromise ||= fetch(CATALOG_URL).then((response) => response.json());
  return catalogPromise;
};
let historicalPromise = null;
const loadHistorical = () => {
  historicalPromise ||= fetch(HISTORICAL_URL).then((response) => response.json());
  return historicalPromise;
};
const loginLink = (label = '登录') => `<a class="button" href="${LOGIN_URL}?returnTo=${encodeURIComponent(location.href)}">${h(label)}</a>`;
const subjectLinks = (pairs) => (pairs || []).map(([slug, name]) => `<a href="/s/${h(slug)}">${h(name)}</a>`).join(' · ');

function setTitle(title) {
  document.title = `${title}｜百年课标`;
}

// ---------- view container ----------

function appRoot() {
  // Pre-rendered shells (search, ai, …) have a container in <main>; fallback routes
  // served by index.html use #app-view instead of the hidden home content.
  const shell = $('.app-shell');
  if (shell) return shell;
  const view = $('#app-view');
  view.hidden = false;
  view.innerHTML = '<div class="wrap app-shell"><p class="loading">正在载入…</p></div>';
  return $('.app-shell', view);
}

// ---------- document ----------

const TEXT_LABELS = {
  official_native_text: '官方文本·可全文检索', ocr_required: '扫描件', ocr_in_quality_review: '扫描件·OCR 待核',
  metadata_only: '仅目录信息', unavailable: '原件暂缺',
};
const VERIFICATION_LABELS = {
  verified_exact: '同版精确核验', verified_stable_fact_only: '稳定事实已核验',
  version_variant_reference_only: '异版仅供参考', conflict_requires_review: '冲突待复核',
  human_judgment_with_warning: '人工判断·有疑点', unresolved_fail_closed: '未确认·禁止引文',
  exact_document_exact_edition: '同文同版', exact_document_revision_uncertain: '同文·版次存疑',
  same_work_different_edition: '同篇异版', stable_fact_only: '仅核稳定事实', not_matched: '未匹配',
};

async function renderDocument(root, id) {
  const [data, catalog] = await Promise.all([
    api(`/api/documents/${encodeURIComponent(id)}?limit=200`),
    loadCatalog().catch(() => null),
  ]);
  const doc = data.document;
  const entry = catalog?.documents.find((item) => item.id === id);
  setTitle(doc.title);
  const paragraphs = (data.paragraphs || []).map((paragraph) => `<section class="para${paragraph.uncertainty_note ? ' uncertain' : ''}" id="p-${h(paragraph.id)}">
  <span class="para-loc">P:${h(paragraph.id)} · ${h(paragraph.source_locator)}</span>
  <p>${h(paragraph.body)}</p>
  ${paragraph.uncertainty_note ? `<small class="note">可能有问题：${h(paragraph.uncertainty_note)}</small>` : ''}
</section>`).join('');
  const verifications = (data.verifications || []).map((item) => `<li><b>${h(item.entity_label || '')} · ${h(VERIFICATION_LABELS[item.verification_status] || item.verification_status)}</b><p>${h(item.resolution || '')}</p>${(item.evidence || []).map((evidence) => `<p><a href="${h(evidence.sourceUrl)}" rel="noopener" target="_blank">${h(evidence.publisher)} ↗</a> · ${h(VERIFICATION_LABELS[evidence.versionMatch] || evidence.versionMatch || '')} · ${h(evidence.factSummary || '')}</p>`).join('')}</li>`).join('');
  const source = doc.source_url ? `<a class="button" href="${h(doc.source_url)}" rel="noopener" target="_blank">打开原件 ↗</a>` : '';
  const page = doc.source_page_url ? `<a href="${h(doc.source_page_url)}" rel="noopener" target="_blank">发布页 ↗</a>` : '';
  root.innerHTML = `<nav class="crumbs" aria-label="位置"><a href="/">首页</a>${entry?.s?.length ? ` / ${subjectLinks(entry.s)}` : ''} / <span>文件</span></nav>
<div class="reader">
  <article class="reader-main">
    <h1>${h(doc.title)}</h1>
    <p class="lede">${h(doc.issued_by || '')}${doc.issued_date ? ` · ${h(doc.issued_date)}` : ''}</p>
    ${paragraphs
      ? `<p class="panel-note">以下为已入库正文，共 ${data.paragraphs.length} 段${data.paragraphs.length >= 200 ? '（只显示前 200 段）' : ''}；P 编号可用于引用与 AI 研究。</p>${paragraphs}`
      : `<div class="panel"><p>这份文件目前只有经核对的目录信息，正文尚未入库或仍在 OCR 核对中。请打开原件阅读。</p>${source}</div>`}
    ${verifications ? `<section class="panel"><h2>在线同版核查</h2><ul class="plain">${verifications}</ul></section>` : ''}
  </article>
  <aside class="reader-side panel">
    <h2>文件信息</h2>
    <dl class="facts">
      <dt>年份</dt><dd>${h(entry?.y ?? doc.sort_year ?? '待核')}</dd>
      <dt>学段</dt><dd>${h(doc.stage || '')}</dd>
      <dt>类型</dt><dd>${h(doc.document_type || '')}</dd>
      <dt>版本</dt><dd>${h(doc.version_label || '')}</dd>
      <dt>文本</dt><dd>${h(TEXT_LABELS[doc.text_quality_status] || doc.text_quality_status || '')}</dd>
      <dt>页数</dt><dd>${h(doc.page_count || '待核')}</dd>
      <dt>编号</dt><dd><code>${h(doc.id)}</code></dd>
    </dl>
    <p>${source} ${page}</p>
    <p><a href="/discussions?documentId=${encodeURIComponent(doc.id)}">围绕这份文件讨论</a></p>
  </aside>
</div>`;
  if (location.hash) requestAnimationFrame(() => document.querySelector(location.hash)?.scrollIntoView({ block: 'center' }));
}

// ---------- historical item ----------

async function renderHistorical(root, id) {
  const items = await loadHistorical();
  const item = items.find((candidate) => candidate.id === id);
  if (!item) {
    root.innerHTML = '<h1>未找到这条历史条目</h1><p><a href="/#subjects">返回学科列表</a></p>';
    return;
  }
  setTitle(item.t);
  const segments = item.seg.map(([start, end, printedStart, printedEnd]) => `<li>扫描页 ${start === end ? start : `${start}–${end}`}${printedStart ? ` · 印刷页 ${printedStart === printedEnd || !printedEnd ? printedStart : `${printedStart}–${printedEnd}`}` : ''}</li>`).join('');
  root.innerHTML = `<nav class="crumbs" aria-label="位置"><a href="/">首页</a>${item.s.length ? ` / ${subjectLinks(item.s)}` : ''} / <span>历史条目</span></nav>
<div class="reader">
  <article class="reader-main">
    <p class="kicker">${h(item.y)} · ${h(item.st)} · ${h(item.ty)}</p>
    <h1>${h(item.t)}</h1>
    <p class="panel-note">出自《${h(item.vt.replace(/^20世纪中国中小学课程标准·教学大纲汇编：/, '20世纪中国中小学课程标准·教学大纲汇编·'))}》。本条按该卷目录与页段定位，是候选文件身份；扫描与 OCR 只辅助阅读，不作正式引文。</p>
    <section class="panel" id="historical-reader"><p class="loading">正在核对原图阅读权限…</p></section>
  </article>
  <aside class="reader-side panel">
    <h2>页段</h2>
    <ul class="plain">${segments}</ul>
    ${item.c.length ? `<h2>OCR 词面</h2><p class="tags">${item.c.map((label) => `<span class="badge">${h(label)}</span>`).join('')}</p><p class="panel-note">词表命中，不代表文件的全部重要概念。</p>` : ''}
    <p><a href="/document/${h(item.v)}">汇编整卷信息</a></p>
  </aside>
</div>`;
  const access = $('#historical-reader', root);
  const me = await loadMe();
  if (!me.authenticated) {
    access.innerHTML = `<h2>登录后查看原图</h2><p>原扫描与完整 OCR 不公开分发。登录统一用户中心后，只加载本条的原始页图与逐页 OCR 候选。</p>${loginLink('登录并查看原图')}`;
    return;
  }
  access.innerHTML = `<h2>原图与逐页内容</h2><p>按需加载本条页段的扫描原图。页图是核对底本；OCR 只辅助阅读，冲突以原图为准。</p><button class="button" type="button" id="load-historical">查看原图</button>`;
  $('#load-historical', access).addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = '正在读取…';
    try {
      const encoded = encodeURIComponent(id);
      const data = await api(`/api/historical/${encoded}`);
      const pages = data.pages.map((page) => `<button type="button" class="chip" data-page="${h(page.ordinal)}" aria-pressed="false">${h(page.printed_page === null ? `扫描页 ${page.physical_page}` : `印刷页 ${page.printed_page}`)}</button>`).join('');
      const texts = data.pages.map((page) => `<details class="ocr-page"><summary>第 ${h(page.ordinal)} 页 · 扫描页 ${h(page.physical_page)}</summary><pre>${h(page.text || '本页 OCR 未识别出可读文字。')}</pre></details>`).join('');
      access.innerHTML = `<h2>原图 · ${h(data.page_count)} 页</h2><p class="panel-note">登录可见，不可公开分发。</p><div class="chips">${pages}</div><iframe class="pdf" title="${h(data.title)} 原图" loading="lazy" src="/api/historical/${encoded}/source.pdf#page=1&view=FitH"></iframe><h3>逐页 OCR 候选</h3>${texts}`;
      const frame = $('iframe', access);
      $$('[data-page]', access).forEach((chip, index) => {
        if (index === 0) chip.setAttribute('aria-pressed', 'true');
        chip.addEventListener('click', () => {
          frame.src = `/api/historical/${encoded}/source.pdf#page=${chip.dataset.page}&view=FitH`;
          $$('[data-page]', access).forEach((other) => other.setAttribute('aria-pressed', String(other === chip)));
        });
      });
    } catch (error) {
      access.innerHTML = `<p class="error">${h(error.message)}</p>`;
    }
  });
}

// ---------- search ----------

function subjectBySlugOrName(catalog, value) {
  if (!value) return null;
  return catalog.subjects.find((subject) => subject.slug === value)
    || catalog.subjects.find((subject) => subject.name === value)
    || catalog.subjects.find((subject) => subject.api.includes(value))
    || null;
}

async function searchPassages(query, subject) {
  const canonical = subject?.api?.length ? subject.api : [''];
  const settled = await Promise.allSettled(canonical.map((name) => api(`/api/search?q=${encodeURIComponent(query)}&subject=${encodeURIComponent(name)}`)));
  const failed = settled.filter((result) => result.status === 'rejected');
  if (failed.length === settled.length) throw failed[0].reason;
  const seen = new Set();
  return settled.flatMap((result) => (result.status === 'fulfilled' ? result.value.passages || [] : []))
    .filter((passage) => !seen.has(passage.id) && seen.add(passage.id))
    .sort((left, right) => Number(left.score || 0) - Number(right.score || 0))
    .slice(0, 40);
}

async function renderSearch(root) {
  const url = new URL(location.href);
  const query = (url.searchParams.get('q') || '').trim();
  const catalog = await loadCatalog();
  const subject = subjectBySlugOrName(catalog, url.searchParams.get('subject') || '');
  const options = catalog.subjects.filter((item) => item.api.length)
    .map((item) => `<option value="${h(item.slug)}"${subject?.slug === item.slug ? ' selected' : ''}>${h(item.name)}</option>`).join('');
  setTitle(query ? `检索：${query}` : '全文检索');
  root.innerHTML = `<header class="page-head">
  <h1>全文检索</h1>
  <p class="lede">检索已入库的课程标准正文（官方文本与已核对段落），并匹配全部文件的篇名。</p>
  <form class="searchbar" id="search-form" role="search">
    <label class="sr" for="search-q">关键词</label>
    <input id="search-q" name="q" type="search" value="${h(query)}" placeholder="至少两个字，例如：学业质量" autocomplete="off">
    <label class="sr" for="search-subject">学科</label>
    <select id="search-subject" name="subject"><option value="">全部学科</option>${options}</select>
    <button type="submit">检索</button>
  </form>
</header>
<div id="search-results"></div>`;
  $('#search-form', root).addEventListener('submit', (event) => {
    event.preventDefault();
    const values = new URLSearchParams(new FormData(event.currentTarget));
    if (!values.get('subject')) values.delete('subject');
    history.pushState(null, '', `/search?${values}`);
    renderSearch(root).catch(showError(root));
  });
  const results = $('#search-results', root);
  if (query.length < 2) {
    results.innerHTML = '<p class="panel-note">输入至少两个字开始检索。</p>';
    return;
  }
  const titleHits = catalog.documents
    .filter((document) => document.t.includes(query) && (!subject || document.s.some(([slug]) => slug === subject.slug)))
    .slice(0, 30);
  results.innerHTML = '<p class="loading">正在检索正文…</p>';
  let passages = [];
  let failure = '';
  try {
    passages = await searchPassages(query, subject);
  } catch (error) {
    failure = error.message;
  }
  results.innerHTML = `<section class="panel"><h2>正文命中 <small>${passages.length}</small></h2>
  ${failure ? `<p class="error">${h(failure)}</p>` : ''}
  ${passages.length ? `<ol class="hits">${passages.map((passage) => `<li><a href="/document/${h(passage.document_id)}#p-${h(passage.id)}">${h(passage.title)}</a><small>${h(passage.entity_label || passage.subject || '')} · ${h(passage.version_label || '')} · ${h(passage.source_locator || '')}</small><p>${h(passage.body)}</p></li>`).join('')}</ol>` : (failure ? '' : '<p>没有正文命中。很多 2011 年以前的文件只有扫描件，正文尚未入库；可在下方篇名结果中打开原件。</p>')}
</section>
<section class="panel"><h2>篇名命中 <small>${titleHits.length}</small></h2>
  ${titleHits.length ? `<ol class="hits">${titleHits.map((document) => `<li><a href="/document/${h(document.id)}">${h(document.t)}</a><small>${h(document.y ?? '')} · ${h(document.st)} · ${subjectLinks(document.s)}</small></li>`).join('')}</ol>` : '<p>没有篇名命中。</p>'}
</section>`;
}

// ---------- AI research ----------

async function researchSubject(query, subject) {
  if (!subject) {
    const data = await api('/api/ai/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, subject: '' }) });
    return { ...data, canonicalSubjects: [], omittedSubjects: [] };
  }
  const checks = await Promise.all(subject.api.map(async (name) => ({ name, data: await api(`/api/search?q=${encodeURIComponent(query)}&subject=${encodeURIComponent(name)}`) })));
  const evidenced = checks.filter(({ data }) => (data.passages || []).length);
  const omittedSubjects = checks.filter(({ data }) => !(data.passages || []).length).map(({ name }) => name);
  if (!evidenced.length) throw new Error('该学科没有找到可引用的正文，请换个关键词。');
  const answers = await Promise.all(evidenced.map(async ({ name }) => ({
    name,
    data: await api('/api/ai/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, subject: name }) }),
  })));
  const canonicalSubjects = answers.map(({ name }) => name);
  const multiple = answers.length > 1;
  const answer = answers.map(({ name, data }) => (multiple ? `【${name}】\n${data.answer}` : data.answer)).join('\n\n');
  const boundary = omittedSubjects.length ? `\n\n证据边界：已分别检索 ${canonicalSubjects.join('、')}；${omittedSubjects.join('、')} 没有可引正文，未生成结论。` : '';
  const seen = new Set();
  return {
    answer: `${answer}${boundary}`,
    citations: answers.flatMap(({ data }) => data.citations || []).filter((citation) => !seen.has(citation.paragraphId) && seen.add(citation.paragraphId)),
    retrievalCount: answers.reduce((total, { data }) => total + Number(data.retrievalCount || 0), 0),
    canonicalSubjects,
    omittedSubjects,
  };
}

async function renderAi(root) {
  const [me, catalog] = await Promise.all([loadMe(), loadCatalog()]);
  setTitle('证据研究');
  const url = new URL(location.href);
  const preset = subjectBySlugOrName(catalog, url.searchParams.get('subject') || '');
  if (!me.authenticated) {
    root.innerHTML = `<header class="page-head"><h1>证据研究</h1><p class="lede">提出一个关于课程标准的问题，系统先检索已核正文，AI 只能引用检索到的段落作答；检索不到证据时不回答。</p></header><div class="panel"><p>研究会话需要登录统一用户中心。</p>${loginLink('前往统一用户中心登录')}</div>`;
    return;
  }
  const options = catalog.subjects.filter((item) => item.api.length)
    .map((item) => `<option value="${h(item.slug)}"${preset?.slug === item.slug ? ' selected' : ''}>${h(item.name)}</option>`).join('');
  root.innerHTML = `<header class="page-head"><h1>证据研究</h1><p class="lede">每个事实都必须回到 [P:编号] 段落；检索不到证据时不会用模型常识补齐。</p></header>
<div class="reader">
  <form class="panel form" id="ai-form">
    <label for="ai-query">研究问题</label>
    <textarea id="ai-query" name="query" rows="6" minlength="8" required placeholder="例如：义务教育语文从 2011 版到 2022 版，课程内容的组织方式有哪些可核验的变化？"></textarea>
    <label for="ai-subject">学科</label>
    <select id="ai-subject" name="subject"><option value="">跨学科</option>${options}</select>
    <button class="button" type="submit">检索并回答</button>
  </form>
  <section class="panel"><h2>回答与引文</h2><div class="answer" id="ai-answer">尚未提问。</div><ol class="hits" id="ai-citations"></ol></section>
</div>`;
  $('#ai-form', root).addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('button', form);
    const answer = $('#ai-answer', root);
    button.disabled = true;
    answer.textContent = '正在检索已核正文并校验引文编号…';
    try {
      const values = Object.fromEntries(new FormData(form));
      const subject = subjectBySlugOrName(catalog, values.subject);
      const data = await researchSubject(values.query, subject);
      answer.textContent = data.answer;
      $('#ai-citations', root).innerHTML = data.citations.map((citation) => `<li><a href="/document/${h(citation.documentId)}#p-${h(citation.paragraphId)}">[P:${h(citation.paragraphId)}] ${h(citation.title)}</a><small>${h(citation.entityLabel || citation.subject || '')} · ${h(citation.locator || '')}</small><p>${h(citation.excerpt || '')}</p></li>`).join('');
      window.BdfzIdentity?.recordEvent?.({
        siteKey: 'curriculum', recordKey: `ai-research:${Date.now()}`, title: '课程标准证据研究', summary: '完成一次带引文的课程标准研究',
        itemGroup: 'teacher-research', itemType: 'rag-query', contentFormat: 'curriculum-atlas-rag-v1', sourceUrl: location.href,
        payload: { eventName: 'ai_evidence_research', subject: subject?.slug || 'cross-subject', canonicalSubjectCount: data.canonicalSubjects.length, retrievalCount: data.retrievalCount },
      })?.catch?.(() => {});
    } catch (error) {
      answer.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}

// ---------- discussions ----------

function setupTurnstile(container, siteKey, callback) {
  if (!siteKey) {
    container.innerHTML = '<p>匿名讨论暂不可提交；请先登录。</p>';
    return;
  }
  const render = () => window.turnstile.render(container, {
    sitekey: siteKey, action: 'curriculum_comment', appearance: 'interaction-only', callback, 'expired-callback': () => callback(''),
  });
  if (window.turnstile) { render(); return; }
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true;
  script.onload = render;
  document.head.append(script);
}

async function loadComments(list, documentId) {
  try {
    const data = await api(`/api/comments?documentId=${encodeURIComponent(documentId)}`);
    list.innerHTML = data.comments.length
      ? data.comments.map((item) => `<li class="comment"><b>${h(item.author_name)}</b><small>${h(new Date(`${item.created_at}Z`).toLocaleString('zh-CN'))}</small><p>${h(item.body)}</p></li>`).join('')
      : '<li class="panel-note">尚无公开讨论。第一条判断也请写明所据版本或条文。</li>';
  } catch (error) {
    list.innerHTML = `<li class="error">${h(error.message)}</li>`;
  }
}

async function renderDiscussions(root) {
  const [me, catalog] = await Promise.all([loadMe(), loadCatalog()]);
  setTitle('教师讨论');
  const url = new URL(location.href);
  const documents = catalog.documents.filter((document) => document.ty !== '历史文献汇编');
  const documentId = url.searchParams.get('documentId') || documents[0]?.id || '';
  const current = documents.find((document) => document.id === documentId);
  root.innerHTML = `<header class="page-head"><h1>教师讨论</h1><p class="lede">围绕同一份文件讨论。登录后发布的内容直接公开；匿名内容需通过人机验证并进入审核。请勿写入学生个人信息。</p></header>
<div class="reader">
  <div>
    <form class="panel form" id="doc-picker"><label for="discussion-document">文件</label><select id="discussion-document" name="documentId">${documents.map((document) => `<option value="${h(document.id)}"${document.id === documentId ? ' selected' : ''}>${h(document.y ?? '')} · ${h(document.t)}</option>`).join('')}</select><button class="button secondary" type="submit">切换</button></form>
    <form class="panel form" id="comment-form"><h2>发表讨论</h2>${me.authenticated ? `<p>以 ${h(me.user?.display_name || me.user?.slug || '')} 发布。</p>` : '<label for="author-name">署名</label><input id="author-name" name="authorName" maxlength="40" value="匿名教师">'}<label for="comment-body">内容</label><textarea id="comment-body" name="body" rows="6" minlength="8" maxlength="2000" required></textarea><div id="turnstile-box"></div><button class="button" type="submit">${me.authenticated ? '发布' : '提交审核'}</button><p class="form-status" aria-live="polite"></p></form>
  </div>
  <section class="panel"><h2>${current ? `<a href="/document/${h(current.id)}">${h(current.t)}</a>` : '讨论'}</h2><ol class="comments" id="comment-list"><li class="loading">正在载入…</li></ol></section>
</div>`;
  $('#doc-picker', root).addEventListener('submit', (event) => {
    event.preventDefault();
    history.pushState(null, '', `/discussions?documentId=${encodeURIComponent(new FormData(event.currentTarget).get('documentId'))}`);
    renderDiscussions(root).catch(showError(root));
  });
  let token = '';
  const box = $('#turnstile-box', root);
  if (me.authenticated) box.remove();
  else {
    const meta = await api('/api/meta').catch(() => ({}));
    setupTurnstile(box, meta.turnstileSiteKey, (value) => { token = value; });
  }
  const status = $('.form-status', root);
  $('#comment-form', root).addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('button', form);
    button.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form));
      body.documentId = documentId;
      body.turnstileToken = token;
      const result = await api('/api/comments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      status.textContent = result.message || '已提交';
      if (result.status === 'approved') await loadComments($('#comment-list', root), documentId);
      else window.turnstile?.reset();
      $('textarea', form).value = '';
    } catch (error) {
      status.textContent = error.message;
      window.turnstile?.reset();
    } finally {
      button.disabled = false;
    }
  });
  loadComments($('#comment-list', root), documentId);
}

// ---------- admin ----------

async function renderAdmin(root) {
  const me = await loadMe();
  setTitle('内容审核');
  if (!me.admin) {
    root.innerHTML = `<h1>内容审核</h1><p>当前账号不在管理员名单中。</p>${me.authenticated ? '' : loginLink()}`;
    return;
  }
  const [summary, comments] = await Promise.all([api('/api/admin/summary'), api('/api/comments?moderation=1')]);
  const pending = comments.comments.filter((item) => item.status === 'pending');
  root.innerHTML = `<h1>内容审核</h1><p>待审核 ${h(summary.pending?.count || 0)} · 开放举报 ${h(summary.reports?.count || 0)} · 7 日 AI 引文失败 ${h(summary.aiFailures?.count || 0)}</p>
<ol class="comments">${pending.map((item) => `<li class="comment"><b>${h(item.author_name)}</b><p>${h(item.body)}</p><p><button class="button" data-moderate="approved" data-id="${h(item.id)}">通过</button> <button class="button secondary" data-moderate="rejected" data-id="${h(item.id)}">拒绝</button></p></li>`).join('') || '<li>当前没有待审核讨论。</li>'}</ol>`;
  $$('[data-moderate]', root).forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api(`/api/admin/comments/${button.dataset.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: button.dataset.moderate }) });
      await renderAdmin(root);
    } catch (error) {
      button.disabled = false;
      alert(error.message);
    }
  }));
}

// ---------- routing for fallback paths and app shells ----------

const LEGACY_FACETS = {
  语文: 'chinese', 数学: 'math', 外语: 'english', 英语: 'english', 思想政治与道德法治: 'politics', 历史: 'history',
  历史与社会: 'history', 地理: 'geography', 物理: 'physics', 化学: 'chemistry', 生物学: 'biology', 科学: 'science',
  劳动: 'labor', 体育与健康: 'pe', 课程方案: 'plans', 音乐: 'music', 美术: 'art', 信息技术: 'it', 信息科技: 'it', 通用技术: 'tech',
};

function legacyRedirect(path, url) {
  const facet = url.searchParams.get('subject') || '';
  const slug = LEGACY_FACETS[facet];
  if (['/subjects', '/compare', '/archive', '/timeline'].includes(path)) {
    const query = url.searchParams.get('q');
    if (query) return `/search?q=${encodeURIComponent(query)}${slug ? `&subject=${slug}` : ''}`;
    return slug ? `/s/${slug}` : '/#subjects';
  }
  if (path === '/sources') return `/search${url.search}`;
  if (path === '/terms') {
    const term = url.searchParams.get('term');
    return term && /[一-鿿]/.test(term) ? `/search?q=${encodeURIComponent(term)}` : '/#aims';
  }
  return null;
}

const showError = (root) => (error) => {
  root.innerHTML = `<h1>暂时无法载入</h1><p class="error">${h(error.message)}</p><p><a href="/">返回首页</a></p>`;
};

async function route() {
  const url = new URL(location.href);
  const path = url.pathname.replace(/\/+$/, '').replace(/\.html$/, '') || '/';
  const shell = $('.app-shell')?.dataset.app;
  const views = { search: renderSearch, ai: renderAi, discussions: renderDiscussions, admin: renderAdmin };
  if (shell && views[shell]) {
    const root = appRoot();
    return views[shell](root).catch(showError(root));
  }
  if (document.documentElement.dataset.route !== 'app') return undefined;
  const target = legacyRedirect(path, url);
  if (target) {
    location.replace(target);
    return undefined;
  }
  const root = appRoot();
  if (path.startsWith('/document/')) return renderDocument(root, decodeURIComponent(path.slice('/document/'.length))).catch(showError(root));
  if (path.startsWith('/historical/')) return renderHistorical(root, decodeURIComponent(path.slice('/historical/'.length))).catch(showError(root));
  setTitle('页面不存在');
  root.innerHTML = '<h1>没有这个页面</h1><p>网站已改版为按学科分页。请从<a href="/">首页</a>或<a href="/#subjects">学科列表</a>进入，或使用<a href="/search">全文检索</a>。</p>';
  return undefined;
}

window.addEventListener('popstate', () => {
  const shell = $('.app-shell')?.dataset.app;
  if (shell === 'search' || shell === 'discussions') route();
});

loadProductionIntegrations();
setupTheme();
setupMenu();
setupAims();
setupFilters();
route();
