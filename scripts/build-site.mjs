// Builds the static site in dist/ from repository data and curated content.
// Every page is pre-rendered HTML; the browser only calls /api/* when a reader asks
// for full text, search, AI research or discussion. The retired star map in public/
// is not shipped; its data layers remain build inputs.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRICULUM_STAGES } from '../public/historical-stages.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = path.join(ROOT, 'dist');
const ORIGIN = 'https://curriculum.bdfz.net';
const SITE_NAME = '百年课标';
const ICON = 'https://img.bdfz.net/20250503004.webp';

const readJson = async (relative) => JSON.parse(await readFile(path.join(ROOT, relative), 'utf8'));
const sha = (value) => createHash('sha256').update(value).digest('hex');

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}
const h = escapeHtml;

// ---------- years ----------

// Mirrors the project's year policy: revision year, then edition label, then issue date,
// then the official issuance-batch rules in data/ocr-document-year-policy.json.
export function documentYear(document) {
  const title = String(document.title || '');
  const revised = title.match(/(\d{4})年修订/);
  if (revised) return Number(revised[1]);
  const edition = title.match(/[（(](\d{4})年版/);
  if (edition) return Number(edition[1]);
  if (document.issued_date) return Number(String(document.issued_date).slice(0, 4));
  if (String(document.id).startsWith('ictr-') && title.startsWith('全日制义务教育') && title.endsWith('（实验稿）')) return 2001;
  if (String(document.id).startsWith('ictr-') && title.startsWith('普通高中') && title.endsWith('（实验）')) return 2003;
  const dated = title.match(/[（(](\d{4})年[）)]/);
  if (dated) return Number(dated[1]);
  if (document.id === 'ictr-07a04c6c51fd') return 2001;
  return null;
}

// ---------- labels ----------

export function stageKey(stage) {
  const value = String(stage || '');
  if (value.includes('特殊教育')) return '特殊教育';
  if (value === '普通高中/高考') return '高考';
  if (value === '普通高中') return '高中';
  if (value === '义务教育') return '义务教育';
  if (value === '小学') return '小学';
  if (value === '中学') return '中学';
  return '综合';
}

export function typeKey(type) {
  const value = String(type || '');
  if (value === '课程标准' || value === '课程纲要') return value;
  if (value === '教学大纲') return '教学大纲';
  if (value === '考试大纲') return '考试大纲';
  if (['课程方案', '教学计划', '课程表', '授课时数表'].includes(value)) return '课程计划';
  if (['学制章程', '法令', '学校规程', '学校条例', '规定'].includes(value)) return '章程法令';
  return '其他文件';
}

const TEXT_LABELS = {
  official_native_text: '官方文本·可全文检索',
  ocr_required: '扫描件',
  ocr_in_quality_review: '扫描件·OCR 待核',
  metadata_only: '仅目录信息',
  unavailable: '原件暂缺',
};

const STATUS_LABELS = {
  current_with_revision_watch: '现行',
  current_reference: '现行参考',
  historical: '历史版本',
  historical_reference: '历史参考',
  superseded: '已有后续版本',
  missing_primary_files: '原件待补',
  revision_watch: '修订动态',
};

// ---------- data ----------

async function loadInputs() {
  const [catalog, century, pre2001, concepts, lifecycle, insights, subjectsFile, aims, taiwan, library] = await Promise.all([
    readJson('data/catalog.json'),
    readJson('public/data/century-observation-layer.json'),
    readJson('public/data/pre2001-subject-detail-observation-layer.json'),
    readJson('public/data/concept-evolution.json'),
    readJson('public/data/discipline-lifecycle.json'),
    readJson('data/subject-insights.json'),
    readJson('content/subjects.json'),
    readJson('content/whole-person-aims.json'),
    readJson('content/taiwan-guowen.json'),
    readJson('content/official-library.json'),
  ]);
  return { catalog, century, pre2001, concepts, lifecycle, insights, subjectsFile, aims, taiwan, library };
}

// Same identity rule as the historical reader package: a pre-2001 item that points at a
// century item is merged into it; every other pre-2001 item keeps its own id.
export function archiveItems(century, pre2001) {
  const byId = new Map(century.items.map((item) => [item.id, {
    id: item.id,
    year: item.year,
    title: item.title,
    stage: item.stage,
    type: item.document_type,
    volume: item.parent_document_id,
    volumeTitle: item.parent_title,
    facets: item.visibility_facets ? [...item.visibility_facets] : (item.subject === '语文' ? ['语文'] : []),
    segments: item.segments.map((segment) => [segment.physical_page_start, segment.physical_page_end, segment.printed_page_start, segment.printed_page_end]),
  }]));
  const aliases = new Map();
  for (const item of pre2001.items) {
    const existing = item.source_item_id ? byId.get(item.source_item_id) : null;
    if (existing) {
      existing.facets = [...new Set([...existing.facets, ...(item.visibility_facets || [])])];
      aliases.set(item.id, existing.id);
      continue;
    }
    byId.set(item.id, {
      id: item.id,
      year: item.year,
      title: item.title,
      stage: item.stage,
      type: item.document_type,
      volume: item.parent_document_id,
      volumeTitle: item.parent_title,
      facets: [...(item.visibility_facets || [])],
      segments: [[item.physical_page_start, item.physical_page_end, item.printed_page_start, item.printed_page_end]],
    });
    aliases.set(item.id, item.id);
  }
  const items = [...byId.values()].sort((left, right) => left.year - right.year || left.title.localeCompare(right.title, 'zh-CN'));
  return { items, aliases };
}

function itemMatchesSubject(item, subject) {
  if ((subject.historical_volumes || []).includes(item.volume)) return true;
  const volumeFacets = subject.historical_volume_facets?.[item.volume];
  if (volumeFacets && item.facets.some((facet) => volumeFacets.includes(facet))) return true;
  if ((subject.historical_facets || []).some((facet) => item.facets.includes(facet))) return true;
  return false;
}

function documentMatchesSubject(document, subject) {
  if ((subject.catalog_exclude_ids || []).includes(document.id)) return false;
  if ((subject.catalog_ids || []).includes(document.id)) return true;
  if ((subject.catalog_subjects || []).includes(document.subject)) return true;
  if ((subject.catalog_types || []).includes(document.document_type)) return true;
  if ((subject.catalog_stages || []).includes(document.stage)) return true;
  return false;
}

const VOLUME_SUBJECTS = {
  'legacy-compendium-plans': ['plans'],
  'legacy-compendium-chinese': ['chinese'],
  'legacy-compendium-mathematics': ['math'],
  'legacy-compendium-english': ['english'],
  'legacy-compendium-politics': ['politics'],
  'legacy-compendium-history': ['history'],
  'legacy-compendium-geography': ['geography'],
  'legacy-compendium-physics': ['physics'],
  'legacy-compendium-chemistry': ['chemistry'],
  'legacy-compendium-biology': ['biology'],
  'legacy-compendium-general-primary': ['science', 'history', 'pe'],
  'legacy-compendium-arts-labor': ['music', 'art', 'tech', 'labor'],
};

function buildModel(inputs) {
  const { catalog, century, pre2001, concepts, lifecycle, insights, subjectsFile } = inputs;
  const subjects = subjectsFile.subjects;
  const documents = catalog.documents.map((document) => ({ ...document, year: documentYear(document) }));
  const volumes = documents.filter((document) => document.document_type === '历史文献汇编');
  const timelineDocuments = documents.filter((document) => document.document_type !== '历史文献汇编');
  const { items, aliases } = archiveItems(century, pre2001);

  const itemSubjects = new Map(items.map((item) => [item.id, []]));
  const documentSubjects = new Map(documents.map((document) => [document.id, []]));
  const perSubject = new Map();
  for (const subject of subjects) {
    const docs = timelineDocuments.filter((document) => documentMatchesSubject(document, subject));
    const historical = items.filter((item) => itemMatchesSubject(item, subject));
    docs.forEach((document) => documentSubjects.get(document.id).push(subject.slug));
    historical.forEach((item) => itemSubjects.get(item.id).push(subject.slug));
    const subjectVolumes = volumes.filter((volume) => (VOLUME_SUBJECTS[volume.id] || []).includes(subject.slug));
    subjectVolumes.forEach((volume) => documentSubjects.get(volume.id).push(subject.slug));
    perSubject.set(subject.slug, { subject, docs, historical, volumes: subjectVolumes });
  }

  // Concept surface observations per subject: modern episodes by canonical subject,
  // historical observations by the archive item they were read from.
  const observations = new Map(subjects.map((subject) => [subject.slug, []]));
  for (const episode of concepts.episodes) {
    const canonical = episode.subject?.canonical;
    const year = episode.time?.year;
    if (!canonical || !year) continue;
    for (const subject of subjects) {
      if ((subject.concept_subjects || []).includes(canonical)) observations.get(subject.slug).push({ label: episode.label, year, layer: 'modern' });
    }
  }
  for (const episode of pre2001.episodes) {
    const itemId = aliases.get(episode.embedded_item_id);
    const year = episode.time?.year;
    if (!itemId || !year) continue;
    for (const slug of itemSubjects.get(itemId) || []) observations.get(slug).push({ label: episode.label, year, layer: 'historical' });
  }
  for (const observation of century.concept_observations) {
    if (!observation.item_id || !observation.year) continue;
    for (const slug of itemSubjects.get(observation.item_id) || []) observations.get(slug).push({ label: observation.label, year: observation.year, layer: 'historical' });
  }

  const itemConcepts = new Map();
  for (const observation of century.concept_observations) {
    if (!observation.item_id) continue;
    const list = itemConcepts.get(observation.item_id) || new Set();
    list.add(observation.label);
    itemConcepts.set(observation.item_id, list);
  }
  for (const episode of pre2001.episodes) {
    const itemId = aliases.get(episode.embedded_item_id);
    if (!itemId) continue;
    const list = itemConcepts.get(itemId) || new Set();
    list.add(episode.label);
    itemConcepts.set(itemId, list);
  }

  const insightRows = (Array.isArray(insights) ? insights : insights.insights).map((row) => ({
    ...row,
    evidence: typeof row.evidence_document_ids === 'string' ? JSON.parse(row.evidence_document_ids) : (row.evidence_document_ids || []),
  }));

  return { subjects, subjectsFile, documents, timelineDocuments, volumes, items, itemSubjects, documentSubjects, perSubject, observations, itemConcepts, insightRows, lifecycle };
}

// ---------- shared rendering ----------

function assetPath(assets, name) {
  return `/assets/${assets[name]}`;
}

function navigation(model, current) {
  const groups = model.subjectsFile.groups.map((group) => {
    const links = model.subjects.filter((subject) => subject.group === group.id)
      .map((subject) => `<li><a href="/s/${subject.slug}"${current === subject.slug ? ' aria-current="page"' : ''}>${h(subject.name)}</a></li>`).join('');
    return `<div class="menu-group"><p>${h(group.label)}</p><ul>${links}</ul></div>`;
  }).join('');
  const item = (href, label, key) => `<li><a href="${href}"${current === key ? ' aria-current="page"' : ''}>${label}</a></li>`;
  return `<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">课</span><span><b>${SITE_NAME}</b><small>课程标准档案 · 1902—2022</small></span></a>
    <nav class="mainnav" aria-label="主导航">
      <ul>
        ${item('/', '首页', 'home')}
        ${item('/#aims', '全人目标', 'aims')}
        <li class="menu"><details><summary${model.subjects.some((subject) => subject.slug === current) ? ' class="is-current"' : ''}>学科</summary><div class="menu-panel">${groups}</div></details></li>
        ${item('/taiwan', '台湾国语文', 'taiwan')}
        ${item('/library', '官方文库', 'library')}
        ${item('/search', '检索', 'search')}
        ${item('/ai', '研究', 'ai')}
      </ul>
    </nav>
    <button class="theme-toggle" type="button" data-theme-toggle aria-label="切换浅色/深色"><span aria-hidden="true">◐</span></button>
  </div>
</header>`;
}

function footer() {
  return `<footer class="sitefoot">
  <div class="wrap">
    <p><b>${SITE_NAME}</b> · curriculum.bdfz.net · 面向教师的课程标准与教学大纲档案</p>
    <p>资料来源：教育部及教育考试院公开文件；课程教材研究所编《20世纪中国中小学课程标准·教学大纲汇编》各卷目录与扫描页；台湾教育部、国家教育研究院公开文件。历史条目的扫描与 OCR 只作定位，不作正式引文。</p>
    <p><a href="/search">全文检索</a> · <a href="/ai">证据研究</a> · <a href="/discussions">教师讨论</a> · <a href="/s/plans">课程方案与学制</a> · <a href="/taiwan">台湾国语文</a> · <a href="/library">官方文库</a></p>
  </div>
</footer>`;
}

function mobileNav(model, current) {
  const subjectSlugs = new Set(model.subjects.map((subject) => subject.slug));
  const key = subjectSlugs.has(current) ? 'subjects' : current;
  const link = (href, icon, label, name) => `<a href="${href}"${key === name ? ' aria-current="page"' : ''}><span class="ic" aria-hidden="true">${icon}</span>${label}</a>`;
  return `<nav class="mobnav" aria-label="底部导航">${link('/', '⌂', '首页', 'home')}${link('/#subjects', '科', '学科', 'subjects')}${link('/library', '库', '文库', 'library')}${link('/taiwan', '台', '台湾', 'taiwan')}${link('/search', '检', '检索', 'search')}${link('/ai', '研', '研究', 'ai')}</nav>`;
}

function page({ assets, model, title, description, pathname, current, body, pageKind, noindex = false }) {
  const fullTitle = title ? `${title}｜${SITE_NAME}` : `${SITE_NAME}｜1902—2022 课程标准档案`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${h(fullTitle)}</title>
<meta name="description" content="${h(description)}">
${noindex ? '<meta name="robots" content="noindex">\n' : ''}<meta name="theme-color" content="#f6f1e6">
<link rel="canonical" href="${ORIGIN}${pathname}">
<meta property="og:type" content="website">
<meta property="og:title" content="${h(fullTitle)}">
<meta property="og:description" content="${h(description)}">
<meta property="og:url" content="${ORIGIN}${pathname}">
<meta property="og:image" content="${ICON}">
<link rel="icon" href="${ICON}" type="image/webp">
<link rel="apple-touch-icon" href="${ICON}">
<script src="${assetPath(assets, 'boot.js')}"></script>
<link rel="stylesheet" href="${assetPath(assets, 'site.css')}">
<script type="module" src="${assetPath(assets, 'app.js')}"></script>
</head>
<body data-page="${h(pageKind)}">
<a class="skip" href="#main">跳到正文</a>
${navigation(model, current)}
<main id="main">
${body}
</main>
<div id="app-view" class="app-view" hidden></div>
${footer()}
${mobileNav(model, current)}
</body>
</html>
`;
}

function sourceLink(source) {
  if (!source) return '';
  if (source.document_id && source.kind === 'corpus') return `<a href="/document/${h(source.document_id)}">${h(source.label)}${source.locator ? ` · ${h(source.locator)}` : ''}</a>`;
  if (source.url) return `<a href="${h(source.url)}" rel="noopener" target="_blank">${h(source.label)} ↗</a>`;
  if (source.historical_id) return `${h(source.label)} · <a href="/historical/${encodeURIComponent(source.historical_id)}">原件条目</a>`;
  return h(source.label);
}

// ---------- whole-person aims ----------

function aimsSection(aims) {
  const dims = aims.dimensions;
  const regions = aims.regions.map((region, index) => {
    const header = region.milestones.map((milestone) => `<th scope="col"><a href="#${h(milestone.id)}" data-aim-link="${h(milestone.id)}"><span class="aim-year">${h(milestone.year)}</span><span class="aim-short">${h(shortAimLabel(milestone))}</span></a></th>`).join('');
    const eraCells = (region.eras || []).map((era) => {
      const span = region.milestones.filter((milestone) => milestone.year >= era.start && milestone.year <= era.end).length;
      return span ? `<th scope="colgroup" colspan="${span}" class="era-cell">${h(era.label)}</th>` : '';
    }).join('');
    const eraRow = eraCells ? `<tr class="era-row"><th class="corner"></th>${eraCells}<th></th></tr>` : '';
    const rows = dims.map((dimension) => {
      const cells = region.milestones.map((milestone) => {
        const phrase = milestone.cells?.[dimension.key];
        return phrase
          ? `<td class="on"><span class="dot" aria-hidden="true"></span><span class="sr">${h(milestone.year)}年：${h(phrase)}</span><span class="tip" aria-hidden="true">${h(phrase)}</span></td>`
          : '<td class="off"><span class="sr">未点名</span></td>';
      }).join('');
      const count = region.milestones.filter((milestone) => milestone.cells?.[dimension.key]).length;
      return `<tr><th scope="row"><b>${h(dimension.label)}</b><small>${h(dimension.name)}</small></th>${cells}<td class="count">${count}/${region.milestones.length}</td></tr>`;
    }).join('');
    const details = region.milestones.map((milestone) => {
      const mapped = dims.filter((dimension) => milestone.cells?.[dimension.key])
        .map((dimension) => `<li><b>${h(dimension.label)}</b>${h(milestone.cells[dimension.key])}</li>`).join('');
      const lang = milestone.quote_lang ? ` lang="${h(milestone.quote_lang)}"` : '';
      return `<details class="aim-card" id="${h(milestone.id)}">
  <summary><span class="aim-card-year">${h(milestone.year)}</span><span>${h(milestone.title)}</span></summary>
  <div class="aim-card-body">
    <p class="aim-issuer">${h(milestone.issuer)}</p>
    <blockquote${lang}>${h(milestone.quote)}</blockquote>
    ${milestone.note ? `<p class="aim-note">${h(milestone.note)}</p>` : ''}
    <ul class="aim-mapped">${mapped || '<li>（没有点名所列维度）</li>'}</ul>
    <p class="aim-source">依据：${sourceLink(milestone.source)}</p>
  </div>
</details>`;
    }).join('');
    return `<section class="aims-region" data-region="${h(region.id)}"${index ? ' data-region-hidden' : ''} aria-labelledby="aims-${h(region.id)}">
  <h3 id="aims-${h(region.id)}" class="region-title">${h(region.label)}<small>${h(region.intro)}</small></h3>
  <div class="matrix-scroll" tabindex="0" role="region" aria-label="${h(region.label)}全人培养要求矩阵，可横向滚动">
    <table class="aims-matrix" style="--n:${region.milestones.length}">
      <caption class="sr">${h(region.label)}：各条文点名的培养维度</caption>
      <colgroup><col class="col-dim">${region.milestones.map(() => '<col class="col-aim">').join('')}<col class="col-count"></colgroup>
      <thead>${eraRow}<tr><th scope="col" class="corner"><span class="corner-label">维度 \\ 年份</span></th>${header}<th scope="col" class="count">合计</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div class="aim-cards">${details}</div>
</section>`;
  }).join('');
  const tabs = aims.regions.map((region, index) => `<button type="button" role="tab" data-region-tab="${h(region.id)}" aria-selected="${index === 0}">${h(region.label)}</button>`).join('');
  return `<section class="block" id="aims" aria-labelledby="aims-title">
  <div class="wrap">
    <h2 class="section-title" id="aims-title">${h(aims.title)}<small>大陆 ${aims.regions[0].milestones.length} 条 · 台湾 ${aims.regions[1].milestones.length} 条正式表述</small></h2>
    <p class="section-lede">${h(aims.boundary)}</p>
    <div class="toggle-row" role="tablist" aria-label="地区" data-js-only>${tabs}</div>
    ${regions}
  </div>
</section>`;
}

function shortAimLabel(milestone) {
  const map = {
    'aim-1906': '学部宗旨', 'aim-1912': '民元宗旨', 'aim-1922': '壬戌学制', 'aim-1929': '三民主义宗旨',
    'aim-1957': '教育方针', 'aim-1958': '教育工作指示', 'aim-1985': '体制改革决定', 'aim-1995': '教育法',
    'aim-1999': '素质教育决定', 'aim-2001': '课改纲要', 'aim-2016': '核心素养', 'aim-2017': '高中方案',
    'aim-2018': '教育大会', 'aim-2020': '高中方案修订', 'aim-2021': '教育法修正', 'aim-2022': '义教方案',
    'tw-aim-1929': '教育宗旨', 'tw-aim-1947': '宪法158条', 'tw-aim-1993': '国小课标', 'tw-aim-1999': '教育基本法',
    'tw-aim-2003': '九年一贯', 'tw-aim-2014': '十二年国教',
  };
  return map[milestone.id] || milestone.title.slice(0, 6);
}

// ---------- home ----------

function decadeCounts(entry) {
  const counts = new Map();
  for (const year of [...entry.docs.map((document) => document.year), ...entry.historical.map((item) => item.year)]) {
    if (!year) continue;
    const decade = Math.floor(year / 10) * 10;
    counts.set(decade, (counts.get(decade) || 0) + 1);
  }
  return counts;
}

function sparkline(entry) {
  const counts = decadeCounts(entry);
  const decades = [];
  for (let decade = 1900; decade <= 2020; decade += 10) decades.push(decade);
  const max = Math.max(1, ...counts.values());
  const width = 130;
  const barWidth = width / decades.length;
  const bars = decades.map((decade, index) => {
    const value = counts.get(decade) || 0;
    const height = value ? Math.max(2, Math.round((value / max) * 28)) : 0;
    return value ? `<rect x="${(index * barWidth + 0.5).toFixed(1)}" y="${30 - height}" width="${(barWidth - 1.5).toFixed(1)}" height="${height}" rx="1"></rect>` : '';
  }).join('');
  return `<svg class="spark" viewBox="0 0 ${width} 32" preserveAspectRatio="none" role="img" aria-label="1900—2020年代文件分布"><line x1="0" y1="30.5" x2="${width}" y2="30.5"></line>${bars}</svg>`;
}

function yearSpan(entry) {
  const years = [...entry.docs.map((document) => document.year), ...entry.historical.map((item) => item.year)].filter(Boolean);
  if (!years.length) return '';
  return `${Math.min(...years)}—${Math.max(...years)}`;
}

function subjectCards(model) {
  return model.subjectsFile.groups.map((group) => {
    const cards = model.subjects.filter((subject) => subject.group === group.id).map((subject) => {
      const entry = model.perSubject.get(subject.slug);
      return `<li><a class="subject-card" href="/s/${subject.slug}" style="--c:${h(subject.color)}">
  <span class="subject-head"><span class="subject-name">${h(subject.name)}</span><span class="subject-count">${entry.docs.length + entry.historical.length} 份</span></span>
  <span class="subject-desc">${h(subject.intro)}</span>
  <span class="subject-meta">${h(yearSpan(entry))} · 现代文件 ${entry.docs.length} · 历史条目 ${entry.historical.length}</span>
  ${sparkline(entry)}
</a></li>`;
    }).join('');
    return `<div class="subject-group"><h3>${h(group.label)}</h3><ul class="subject-grid">${cards}</ul></div>`;
  }).join('');
}

function homePage(context) {
  const { model, aims, taiwan, library } = context;
  const totalDocs = model.timelineDocuments.length;
  const totalItems = model.items.length;
  const body = `<section class="hero">
  <div class="wrap">
    <h1>${SITE_NAME}</h1>
    <p class="lede">中国课程标准与教学大纲 1902—2022 · 按学科逐份查看，附原件与可检索全文；全人培养要求的变迁；台湾国语文课程</p>
    <form class="searchbar" action="/search" method="get" role="search">
      <label class="sr" for="home-q">检索课程标准正文</label>
      <input id="home-q" name="q" type="search" placeholder="检索正文或篇名（如：学习任务群 / 核心素养 / 劳动教育）" autocomplete="off">
      <button type="submit">检索</button>
    </form>
    <ul class="stats">
      <li><b>${model.subjects.length}</b><span>学科与专题</span></li>
      <li><b>${totalDocs}</b><span>现代课程文件</span></li>
      <li><b>${totalItems}</b><span>1902—2000 历史条目</span></li>
      <li><b>${aims.regions.reduce((sum, region) => sum + region.milestones.length, 0)}</b><span>全人培养表述</span></li>
      <li><b>${taiwan.tracks.reduce((sum, track) => sum + track.versions.length, 0)}</b><span>台湾国语文版本</span></li>
    </ul>
  </div>
</section>
<div class="wrap">
  <p class="source-note"><b>资料说明</b> · 2001 年以来的文件来自教育部及教育考试院公开原件，已入库的正文可全文检索；1902—2000 年条目来自课程教材研究所编《20世纪中国中小学课程标准·教学大纲汇编》各卷目录与扫描页，只作定位，不作正式引文。</p>
</div>
${aimsSection(aims)}
<section class="block" id="subjects" aria-labelledby="subjects-title">
  <div class="wrap">
    <h2 class="section-title" id="subjects-title">按学科浏览<small>${model.subjects.length} 个学科与专题</small></h2>
    <p class="section-lede">${h(model.subjectsFile.boundary)}</p>
    ${subjectCards(model)}
  </div>
</section>
<section class="block" aria-labelledby="tw-title">
  <div class="wrap">
    <h2 class="section-title" id="tw-title">台湾国语文<small>1948—2018 历次课程标准与课程纲要</small></h2>
    <a class="feature-card" href="/taiwan">
      <span class="kicker">新增专题</span>
      <span class="feature-title">${h(taiwan.title)}</span>
      <span class="feature-facts">${h(taiwan.intro)}</span>
      <span class="feature-facts">高中文言比例：101 课纲 45%—65% → 108 课纲 35%—45% · 文言选文参考：30 篇 → 推荐 15 篇</span>
    </a>
  </div>
</section>
<section class="block" aria-labelledby="library-title">
  <div class="wrap">
    <h2 class="section-title" id="library-title">官方文库<small>全文库之外已核对的官方原件</small></h2>
    <a class="feature-card" href="/library">
      <span class="kicker">原件目录</span>
      <span class="feature-title">课程政策、专题纲要、中职课标与台湾历次课纲</span>
      <span class="feature-facts">大陆 ${libraryCount(library, 'cn')} 项 · 台湾 ${libraryCount(library, 'tw')} 项 · ${libraryFileCount(library)} 个文件逐一记录大小与 SHA-256 · 核对于 ${h(library.checked_at)}</span>
      <span class="feature-facts">含 2025 年 10 月课程方案和课程标准日常修订版的修订动态。</span>
    </a>
  </div>
</section>`;
  return page({ ...context, title: '', description: '按学科查看1902—2022年中国课程标准、教学大纲与考试大纲；全人培养要求的变迁；台湾国语文课程标准与课程纲要。', pathname: '/', current: 'home', body, pageKind: 'home' });
}

// ---------- subject pages ----------

function eraFor(year) {
  return CURRICULUM_STAGES.find((stage) => year >= stage.start && year <= stage.end) || null;
}

function documentRow(document, subject) {
  const stage = stageKey(document.stage);
  const type = typeKey(document.document_type);
  const integrated = (subject.integrated_ids || []).includes(document.id);
  const badges = [
    `<span class="badge">${h(stage)}</span>`,
    `<span class="badge">${h(document.document_type)}</span>`,
    integrated ? '<span class="badge badge-note">综合课程</span>' : '',
    document.current_status && STATUS_LABELS[document.current_status] === '现行' ? '<span class="badge badge-accent">现行</span>' : '',
    `<span class="badge ${document.text_quality_status === 'official_native_text' ? 'badge-jade' : 'badge-quiet'}">${h(TEXT_LABELS[document.text_quality_status] || document.text_quality_status || '')}</span>`,
  ].join('');
  const lang = subject.filters ? ` data-lang="${h(document.subject)}"` : '';
  const source = document.source_url ? `<a href="${h(document.source_url)}" rel="noopener" target="_blank">原件 ↗</a>` : '';
  return `<li class="row" data-stage="${h(stage)}" data-type="${h(type)}"${lang} data-text="${h(`${document.title} ${document.issued_by || ''}`)}">
  <span class="row-year">${h(document.year ?? '—')}</span>
  <div class="row-main">
    <a class="row-title" href="/document/${h(document.id)}">${h(document.title)}</a>
    <span class="row-badges">${badges}</span>
  </div>
  <span class="row-links">${source}</span>
</li>`;
}

function historicalRow(item, subject) {
  const stage = stageKey(item.stage);
  const type = typeKey(item.type);
  const pages = item.segments.map(([start, end]) => (start === end ? `${start}` : `${start}–${end}`)).join('、');
  return `<li class="row row-historical" data-stage="${h(stage)}" data-type="${h(type)}"${subject.filters ? ' data-lang="英语"' : ''} data-text="${h(item.title)}">
  <span class="row-year">${h(item.year)}</span>
  <div class="row-main">
    <a class="row-title" href="/historical/${encodeURIComponent(item.id)}">${h(item.title)}</a>
    <span class="row-badges"><span class="badge">${h(item.stage)}</span><span class="badge">${h(item.type)}</span><span class="badge badge-quiet">汇编扫描页 ${h(pages)}</span></span>
  </div>
  <span class="row-links"></span>
</li>`;
}

function timeline(entry) {
  const { subject, docs, historical } = entry;
  const rows = [
    ...historical.map((item) => ({ year: item.year, sort: `${item.year}-0-${item.title}`, html: historicalRow(item, subject) })),
    ...docs.map((document) => ({ year: document.year, sort: `${document.year ?? 9999}-1-${document.title}`, html: documentRow(document, subject) })),
  ].sort((left, right) => (left.year ?? 9999) - (right.year ?? 9999) || left.sort.localeCompare(right.sort, 'zh-CN'));
  const groups = new Map();
  for (const row of rows) {
    const era = row.year ? eraFor(row.year) : null;
    const key = era ? era.id : 'undated';
    if (!groups.has(key)) groups.set(key, { era, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].map(({ era, rows: eraRows }) => `<section class="era" data-era>
  <h3>${era ? `${h(era.label)} <small>${era.start}—${era.end === 2022 ? '至今' : era.end}</small>` : '年份待核'}</h3>
  <ol class="rows">${eraRows.map((row) => row.html).join('')}</ol>
</section>`).join('');
}

function filterBar(entry) {
  const { subject, docs, historical } = entry;
  const stages = new Set([...docs.map((document) => stageKey(document.stage)), ...historical.map((item) => stageKey(item.stage))]);
  const stageOrder = ['小学', '中学', '义务教育', '高中', '高考', '特殊教育', '综合'];
  const types = new Set([...docs.map((document) => typeKey(document.document_type)), ...historical.map((item) => typeKey(item.type))]);
  const typeOrder = ['课程标准', '教学大纲', '课程纲要', '考试大纲', '课程计划', '章程法令', '其他文件'];
  const group = (name, label, values) => `<div class="filter-row" role="group" aria-label="${h(label)}"><span>${h(label)}</span><div class="pills">${['', ...values].map((value) => `<button type="button" class="pill" data-filter="${name}" data-value="${h(value)}" aria-pressed="${value === ''}">${h(value || '全部')}</button>`).join('')}</div></div>`;
  const languages = subject.filters ? group('lang', subject.filters.label, subject.filters.values) : '';
  return `<div class="filters" data-js-only>
  ${group('stage', '学段', stageOrder.filter((value) => stages.has(value)))}
  ${group('type', '类型', typeOrder.filter((value) => types.has(value)))}
  ${languages}
  <div class="filter-search"><label class="sr" for="filter-text">在本页篇名中查找</label><input id="filter-text" type="search" data-filter-text placeholder="在本页篇名中查找"><output data-filter-count aria-live="polite"></output></div>
</div>`;
}

function titleForms(entry) {
  const { subject, docs, historical } = entry;
  const titles = [...docs.map((document) => ({ year: document.year, title: document.title })), ...historical.map((item) => ({ year: item.year, title: item.title }))].filter((row) => row.year);
  const candidates = subject.title_forms || [];
  // A title counts for the longest form it contains: “思想政治” is not also “政治”.
  const formsIn = (title) => {
    const found = candidates.filter((form) => title.includes(form));
    return found.filter((form) => !found.some((other) => other !== form && other.includes(form)));
  };
  const forms = candidates.map((form) => {
    const years = titles.filter((row) => formsIn(row.title).includes(form)).map((row) => row.year);
    return years.length ? { form, first: Math.min(...years), last: Math.max(...years), count: years.length } : null;
  }).filter(Boolean).sort((left, right) => left.first - right.first || right.count - left.count);
  if (!forms.length) return '';
  const min = 1900;
  const max = 2025;
  const pct = (year) => (((year - min) / (max - min)) * 100).toFixed(2);
  const rows = forms.map((form) => `<li><span class="form-name">${h(form.form)}</span><span class="form-track"><span class="form-bar" style="left:${pct(form.first)}%;width:max(6px, ${(pct(form.last) - pct(form.first)).toFixed(2)}%)"></span></span><span class="form-years">${form.first === form.last ? form.first : `${form.first}—${form.last}`} · ${form.count} 份</span></li>`).join('');
  return `<section class="panel" aria-labelledby="forms-title">
  <h2 id="forms-title">科目名称在文件题名中的出现</h2>
  <p class="panel-note">统计本页文件题名里出现该名称的最早与最晚年份，只反映题名用字，不等于课程设置的起止。</p>
  <ol class="forms">${rows}</ol>
  <div class="axis forms-axis" aria-hidden="true"><span>1900</span><span>1950</span><span>2000</span><span>2025</span></div>
</section>`;
}

function lifecycleEvents(model, entry) {
  const facet = entry.subject.lifecycle_facet;
  if (!facet) return '';
  const events = model.lifecycle.events.filter((event) => (event.public_facets || []).includes(facet));
  if (!events.length) return '';
  const sources = new Map(model.lifecycle.sources.map((source) => [source.id, source]));
  const rows = events.map((event) => {
    const links = (event.source_ids || []).map((id) => sources.get(id)).filter(Boolean).map((source) => {
      const href = source.locator.startsWith('http') ? source.locator : source.locator;
      const external = source.locator.startsWith('http');
      return `<a href="${h(href)}"${external ? ' rel="noopener" target="_blank"' : ''}>${h(source.title)}${external ? ' ↗' : ''}</a>`;
    }).join('；');
    return `<li><span class="ev-year">${h(event.year)}</span><div><b>${h(event.label)}</b><p>${h(event.detail)}</p><small>依据：${links}</small></div></li>`;
  }).join('');
  return `<section class="panel" aria-labelledby="events-title">
  <h2 id="events-title">设置变化</h2>
  <ol class="events">${rows}</ol>
</section>`;
}

function rankConcepts(list, limit) {
  const byLabel = new Map();
  for (const { label, year } of list) {
    const record = byLabel.get(label) || new Set();
    record.add(year);
    byLabel.set(label, record);
  }
  return [...byLabel.entries()].map(([label, years]) => ({ label, years: [...years].sort((left, right) => left - right) }))
    .sort((left, right) => right.years.length - left.years.length || left.years[0] - right.years[0] || left.label.localeCompare(right.label, 'zh-CN'))
    .slice(0, limit)
    .sort((left, right) => left.years[0] - right.years[0] || left.label.localeCompare(right.label, 'zh-CN'));
}

function conceptTable(rows, columns, caption, binary = false) {
  const head = columns.map((column) => `<th scope="col" title="${h(column.title)}"><span>${h(column.label)}</span><small>${h(column.small)}</small></th>`).join('');
  const body = rows.map((row) => {
    const cells = columns.map((column) => {
      const hits = row.years.filter((year) => year >= column.start && year <= column.end);
      if (!hits.length) return '<td></td>';
      const level = binary ? 3 : Math.min(3, hits.length);
      return `<td class="hit l${level}" title="${h(row.label)}：${hits.join('、')}"><span class="sr">${hits.join('、')}</span></td>`;
    }).join('');
    return `<tr><th scope="row">${h(row.label)}</th>${cells}<td class="count">${row.years.length}</td></tr>`;
  }).join('');
  return `<div class="matrix-scroll" tabindex="0" role="region" aria-label="${h(caption)}，可横向滚动">
  <table class="concept-matrix"><caption class="sr">${h(caption)}</caption><thead><tr><th scope="col">关键词</th>${head}<th scope="col">年份数</th></tr></thead><tbody>${body}</tbody></table>
</div>`;
}

function conceptGrid(model, entry) {
  const list = model.observations.get(entry.subject.slug) || [];
  const historical = rankConcepts(list.filter((row) => row.layer === 'historical' && row.year <= 2000), 24);
  const modern = rankConcepts(list.filter((row) => row.layer === 'modern' && row.year >= 2001), 20);
  if (!historical.length && !modern.length) return '';
  const eras = CURRICULUM_STAGES.filter((stage) => stage.end <= 2000)
    .map((stage) => ({ label: stage.shortLabel, small: String(stage.start), title: `${stage.label} ${stage.start}—${stage.end}`, start: stage.start, end: stage.end }));
  const modernYears = [...new Set(modern.flatMap((row) => row.years))].sort((left, right) => left - right)
    .map((year) => ({ label: String(year), small: '', title: String(year), start: year, end: year }));
  return `<section class="panel" aria-labelledby="concepts-title">
  <details class="concepts">
    <summary><h2 id="concepts-title">关键词年谱</h2><span>词面在各年代文件中的出现</span></summary>
    <p class="panel-note">两套来源分开呈现，不能横向比较：1902—2000 年取自汇编扫描页 OCR 的词表命中，2001 年以来取自已入库正文的概念标注。只表示该词出现，不表示含义相同；空格不表示该词没有出现在原文里。</p>
    ${historical.length ? `<h3 class="sub">1902—2000 年（按年代，${historical.length} 个出现年份最多的词）</h3>${conceptTable(historical, eras, '1902—2000年关键词年谱')}<p class="panel-note">颜色越深，表示该年代内有越多年份的文件出现此词。</p>` : ''}
    ${modern.length ? `<h3 class="sub">2001 年以来（按年份，${modern.length} 个概念）</h3>${conceptTable(modern, modernYears, '2001年以来概念年谱', true)}` : ''}
  </details>
</section>`;
}

function insightsPanel(model, entry) {
  const map = { chinese: ['语文'], math: ['数学'], science: ['科学'], physics: ['科学'], chemistry: ['科学'], biology: ['科学'], exam: ['考试评价'], plans: ['综合'] };
  const keys = map[entry.subject.slug];
  if (!keys) return '';
  const rows = model.insightRows.filter((row) => keys.includes(row.subject));
  if (!rows.length) return '';
  const titles = new Map(model.documents.map((document) => [document.id, document.title]));
  return `<section class="panel" aria-labelledby="insight-title">
  <h2 id="insight-title">编辑判断</h2>
  <ul class="insights">${rows.map((row) => `<li><div><span class="insight-era">${h(row.era)}</span><b>${h(row.title)}</b><p>${h(row.summary)}</p><small>依据：${row.evidence.map((id) => `<a href="/document/${h(id)}">${h(titles.get(id) || id)}</a>`).join('；')}</small></div></li>`).join('')}</ul>
</section>`;
}

function subjectPage(context, entry) {
  const { model } = context;
  const { subject, docs, historical, volumes } = entry;
  const related = (subject.related || []).map((slug) => {
    if (slug === 'taiwan') return '<a href="/taiwan">台湾国语文</a>';
    const target = model.subjects.find((candidate) => candidate.slug === slug);
    return target ? `<a href="/s/${slug}">${h(target.name)}</a>` : '';
  }).filter(Boolean).join(' · ');
  const volumeLinks = volumes.map((volume) => `<li><a href="/document/${h(volume.id)}">${h(volume.title)}</a> <small>${h(volume.page_count || '')} 页 · 扫描件</small></li>`).join('');
  const searchSubject = subject.api_subjects?.length ? `<input type="hidden" name="subject" value="${h(subject.slug)}">` : '';
  const body = `<div class="wrap subject-page" data-subject="${h(subject.slug)}">
  <nav class="crumbs" aria-label="位置"><a href="/">首页</a> / <a href="/#subjects">学科</a> / <span>${h(subject.name)}</span></nav>
  <header class="page-head">
    <h1>${h(subject.name)}</h1>
    <p class="lede">${h(subject.intro)}</p>
    <div class="cov-grid">
      <div class="cov-card"><b>${h(yearSpan(entry) || '—')}</b><span>年份范围</span></div>
      <div class="cov-card"><b>${docs.length}</b><span>现代课程文件</span></div>
      <div class="cov-card"><b>${historical.length}</b><span>1902—2000 历史条目</span></div>
    </div>
    <form class="searchbar left" action="/search" method="get" role="search">
      <label class="sr" for="subject-q">在${h(subject.name)}中检索正文</label>
      <input id="subject-q" name="q" type="search" placeholder="在${h(subject.name)}课程文件正文中检索" autocomplete="off">
      ${searchSubject}
      <button type="submit">检索</button>
    </form>
  </header>
  <div class="subject-layout">
    <div class="subject-main">
      <section aria-labelledby="timeline-title">
        <h2 class="section-title" id="timeline-title">版本时间线<small>${docs.length + historical.length} 份，按年代排列</small></h2>
        ${subject.historical_note ? `<p class="section-lede">${h(subject.historical_note)}</p>` : ''}
        ${filterBar(entry)}
        <div class="timeline list-card">${timeline(entry)}<p class="empty" data-filter-empty hidden>没有符合条件的文件。</p></div>
      </section>
      ${conceptGrid(model, entry)}
    </div>
    <aside class="subject-side">
      ${titleForms(entry)}
      ${lifecycleEvents(model, entry)}
      ${insightsPanel(model, entry)}
      ${librarySubjectPanel(context.library, subject)}
      ${volumeLinks ? `<section class="panel"><h2>历史条目来源</h2><ul class="plain">${volumeLinks}</ul><p class="panel-note">课程教材研究所编，人民教育出版社 2001 年版。条目按各卷目录与页段定位；登录后可看原图。</p></section>` : ''}
      ${related ? `<section class="panel"><h2>相关</h2><p>${related}</p></section>` : ''}
    </aside>
  </div>
</div>`;
  return page({ ...context, title: subject.name, description: `${subject.name}：${subject.intro}`.slice(0, 160), pathname: `/s/${subject.slug}`, current: subject.slug, body, pageKind: 'subject' });
}

// ---------- Taiwan ----------

function taiwanPage(context) {
  const { model, taiwan, library } = context;
  const officialFor = (trackId, year) => library.items.filter((item) => (item.tracks || []).some(([id, y]) => id === trackId && y === year));
  // Sources are cited as numbered notes; the full list is rendered once at the end.
  const sourceOrder = [];
  const sourceRef = (id) => {
    if (!taiwan.sources[id]) return '';
    if (!sourceOrder.includes(id)) sourceOrder.push(id);
    return `<a class="fn" href="#src-${h(id)}">[${sourceOrder.indexOf(id) + 1}]</a>`;
  };
  const point = (value) => (typeof value === 'string' ? h(value) : `<span class="quote" lang="zh-Hant">「${h(value.q)}」</span>`);
  const confidence = (value) => `<span class="badge ${value === 'official' ? 'badge-accent' : 'badge-quiet'}">${h(taiwan.confidence_labels[value] || value)}</span>`;

  // Lane chart: three stage tracks, 1945—2025.
  const min = 1945;
  const max = 2025;
  const width = 1000;
  const left = 70;
  const x = (year) => (left + ((year - min) / (max - min)) * (width - left - 20)).toFixed(1);
  const laneHeight = 54;
  const lanes = taiwan.tracks.map((track, index) => {
    const y = 40 + index * laneHeight;
    const marks = track.versions.map((version) => {
      const outline = version.kind.includes('纲要') ? 'mark-guideline' : 'mark-standard';
      return `<g class="${outline}"><circle cx="${x(version.year)}" cy="${y}" r="7"><title>${h(version.year)} ${h(version.title)}</title></circle><text x="${x(version.year)}" y="${y + 24}" text-anchor="middle">${String(version.year).slice(2)}</text></g>`;
    }).join('');
    return `<g class="lane"><text class="lane-label" x="0" y="${y + 5}">${h(track.short || track.label)}</text><line x1="${left}" y1="${y}" x2="${width - 20}" y2="${y}"></line>${marks}</g>`;
  }).join('');
  const ticks = [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020].map((year) => `<g class="tick"><line x1="${x(year)}" y1="18" x2="${x(year)}" y2="${40 + (taiwan.tracks.length - 1) * laneHeight + 30}"></line><text x="${x(year)}" y="12" text-anchor="middle">${year}</text></g>`).join('');
  const chartHeight = 40 + (taiwan.tracks.length - 1) * laneHeight + 40;
  const laneChart = `<figure class="chart">
  <svg viewBox="0 0 ${width} ${chartHeight}" role="img" aria-labelledby="lane-title lane-desc"><title id="lane-title">台湾国语文课程版本时间轴</title><desc id="lane-desc">三条轨道分别为国民小学、国民中学、高级中学；实心圆为课程标准，空心圆为课程纲要。详细列表见下文。</desc>${ticks}${lanes}</svg>
  <figcaption><span class="legend"><i class="lg-standard"></i>课程标准</span><span class="legend"><i class="lg-guideline"></i>课程纲要（含暂行、微调）</span>数字为公布年份后两位。</figcaption>
</figure>`;

  const naming = taiwan.naming.map((row) => `<li><b>${h(row.stage)}</b><ol class="naming-steps">${row.steps.map((step) => `<li><span>${h(step.year)}</span><span lang="zh-Hant">${h(step.name)}</span></li>`).join('')}</ol></li>`).join('');

  const tracks = taiwan.tracks.map((track) => `<section class="panel tw-track" aria-labelledby="track-${h(track.id)}">
  <h2 id="track-${h(track.id)}">${h(track.label)}</h2>
  <ol class="tw-versions">${track.versions.map((version) => {
    const historical = version.historical_title ? model.items.find((item) => item.title === version.historical_title) : null;
    return `<li>
    <span class="row-year">${h(version.year)}</span>
    <div>
      <h3 lang="zh-Hant">${h(version.title)}</h3>
      <p class="row-badges"><span class="badge">${h(version.kind)}</span>${version.implemented ? `<span class="badge">${h(version.implemented)}</span>` : ''}${confidence(version.confidence)}</p>
      <ul class="tw-points">${version.points.map((value) => `<li>${point(value)}</li>`).join('')}</ul>
      ${historical ? `<p class="tw-link"><a href="/historical/${encodeURIComponent(historical.id)}">查看本站百年资料中的条目</a></p>` : ''}
      ${officialFor(track.id, version.year).map((item) => `<p class="tw-link"><a href="#lib-${h(item.id)}">官方原件：${h(item.files[0]?.format || '通知页')} · ${h(LIBRARY_PUBLISHER[item.page.label] || item.page.label)}</a></p>`).join('')}
      <p class="tw-source">依据 ${version.sources.map(sourceRef).join(' ')}</p>
    </div>
  </li>`;
  }).join('')}</ol>
</section>`).join('');

  const ratio = taiwan.classical_ratio;
  const bar = (row) => `<li><span class="ratio-label">${h(row.label)}</span><span class="ratio-track"><span class="ratio-bar" style="left:${row.min}%;width:${row.max - row.min}%"></span></span><span class="ratio-val">${row.min}%—${row.max}%</span></li>`;
  const ratioChart = `<section class="panel" aria-labelledby="ratio-title">
  <h2 id="ratio-title">文言文比例</h2>
  <p class="panel-note">${h(ratio.note)}</p>
  <h3 class="sub">高中（普通高中）</h3>
  <ol class="ratios">${ratio.senior.map(bar).join('')}</ol>
  <h3 class="sub">国中（108 课纲，逐年增加）</h3>
  <ol class="ratios">${ratio.junior.map(bar).join('')}</ol>
  <div class="axis ratio-axis" aria-hidden="true"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
</section>`;

  const readings = taiwan.readings;
  const matched = new Map(readings.list108.filter((row) => row.match).map((row) => [row.match, row]));
  const list101 = readings.list101.map((row) => {
    const hit = matched.get(row.n);
    const state = hit ? (hit.relation === 'same' ? 'kept' : 'specified') : 'dropped';
    const label = { kept: '保留', specified: '改为单篇', dropped: '未列入 15 篇' }[state];
    return `<li class="${state}"><span class="rd-n">${row.n}</span><span lang="zh-Hant">${h(row.title)}</span><small lang="zh-Hant">${h(row.author)}</small><span class="rd-state">${label}</span></li>`;
  }).join('');
  const list108 = readings.list108.map((row) => {
    const state = row.relation === 'same' ? 'kept' : row.relation === 'new' ? 'new' : 'specified';
    const label = { kept: '沿用', specified: row.relation_note || '改为单篇', new: '新增' }[state];
    return `<li class="${state}"><span class="rd-n">${row.n}</span><span lang="zh-Hant">${h(row.title)}</span><small lang="zh-Hant">${h(row.author)}</small><span class="rd-state">${h(label)}</span></li>`;
  }).join('');
  const keptCount = readings.list108.filter((row) => row.relation === 'same').length;
  const specifiedCount = readings.list108.filter((row) => row.relation === 'specified').length;
  const newCount = readings.list108.filter((row) => row.relation === 'new').length;
  const readingsPanel = `<section class="panel" aria-labelledby="readings-title">
  <h2 id="readings-title">高中文言选文参考：30 篇 → 15 篇</h2>
  <p class="panel-note">${h(readings.note)} 108 版 15 篇中，沿用 ${keptCount} 篇，由选集指定为单篇 ${specifiedCount} 篇，新增 ${newCount} 篇（均为台湾古典散文）。</p>
  <div class="readings">
    <div><h3 class="sub">101 课纲 附件一（30 篇）</h3><ol class="reading-list">${list101}</ol><p class="tw-source">依据 ${sourceRef(readings.list101_source)}</p></div>
    <div><h3 class="sub">108 课纲 附录四（15 篇）</h3><ol class="reading-list">${list108}</ol><p class="tw-source">依据 ${sourceRef(readings.list108_source)}</p></div>
  </div>
</section>`;

  const goals = `<section class="panel" aria-labelledby="goals-title">
  <h2 id="goals-title">课程目标：101 高中国文 与 108 国语文</h2>
  <div class="readings">
    <div><h3 class="sub">101 课纲（高中国文，3 项）</h3><ol class="goal-list" lang="zh-Hant">${taiwan.goals101.items.map((item) => `<li>${h(item)}</li>`).join('')}</ol><p class="tw-source">依据 ${sourceRef(taiwan.goals101.source)}</p></div>
    <div><h3 class="sub">108 课纲（国语文，8 项）</h3><ol class="goal-list" lang="zh-Hant">${taiwan.goals108.items.map((item) => `<li>${h(item)}</li>`).join('')}</ol><p class="panel-note">学习内容分为 <span lang="zh-Hant">${taiwan.goals108.content_axes.map(h).join('、')}</span> 三类。</p><p class="tw-source">依据 ${sourceRef(taiwan.goals108.source)}</p></div>
  </div>
</section>`;

  const shared = model.items.filter((item) => item.volume === 'legacy-compendium-chinese' && item.year <= 1948 && item.year >= 1912);
  const sharedPanel = `<section class="panel" aria-labelledby="shared-title">
  <details>
    <summary><h2 id="shared-title">1949 年以前的共同源流</h2><span>${shared.length} 条民国时期语文（国文、国语）课程文件</span></summary>
    <p class="panel-note">民国时期公布、1949 年后在台湾继续沿用或作为修订基础的课程标准，收在本站“语文”页。</p>
    <ol class="rows">${shared.map((item) => `<li class="row"><span class="row-year">${h(item.year)}</span><div class="row-main"><a class="row-title" href="/historical/${encodeURIComponent(item.id)}">${h(item.title)}</a><span class="row-badges"><span class="badge">${h(item.stage)}</span></span></div></li>`).join('')}</ol>
  </details>
</section>`;

  const body = `<div class="wrap subject-page">
  <nav class="crumbs" aria-label="位置"><a href="/">首页</a> / <span>台湾国语文</span></nav>
  <header class="page-head">
    <h1>${h(taiwan.title)}</h1>
    <p class="lede">${h(taiwan.intro)}</p>
    <p class="panel-note">${h(taiwan.boundary)}</p>
  </header>
  ${laneChart}
  <section class="panel" aria-labelledby="naming-title"><h2 id="naming-title">科目名称</h2><ul class="naming">${naming}</ul><p class="tw-source">依据 ${sourceRef('naer-history')} ${sourceRef('k12-108')}</p></section>
  <div class="tw-columns">${tracks}</div>
  ${ratioChart}
  ${readingsPanel}
  ${goals}
  ${sharedPanel}
  <section class="panel" id="library" aria-labelledby="tw-library-title">
    <h2 id="tw-library-title">官方课纲原件<small> ${libraryCount(library, 'tw')} 项，核对于 ${h(library.checked_at)}</small></h2>
    <p class="panel-note">台湾教育部发布、国家教育研究院与国民及学前教育署公开的课纲原件。上方时间轴中标“研究文献”的版本，凡能找到官方原件的都在此列出；1990 年以前各版课程标准与 2000 年暂行纲要未见官方电子原件。</p>
    ${libraryRegion(library, 'tw')}
  </section>
  <section class="panel"><h2>相关</h2><p><a href="/s/chinese">语文（大陆）</a> · <a href="/#aims">全人培养要求：台湾一栏</a> · <a href="/library">官方文库</a></p></section>
  <section class="panel" aria-labelledby="sources-title"><h2 id="sources-title">资料来源</h2><ol class="sources">${sourceOrder.map((id) => {
    const source = taiwan.sources[id];
    return `<li id="src-${h(id)}">${source.url ? `<a href="${h(source.url)}" rel="noopener" target="_blank">${h(source.label)} ↗</a>` : h(source.label)}</li>`;
  }).join('')}</ol></section>
</div>`;
  return page({ ...context, title: '台湾国语文', description: '台湾国小国语、国中国文、高中国文课程标准与课程纲要的历次修订；文言文比例、选文清单与课程目标的变化。', pathname: '/taiwan', current: 'taiwan', body, pageKind: 'taiwan' });
}

// ---------- official library ----------

const LIBRARY_PUBLISHER = { '國家教育研究院': '国家教育研究院', '教育部國民及學前教育署': '国民及学前教育署' };

const libraryCount = (library, region) => library.items.filter((item) => item.region === region).length;
const libraryFileCount = (library) => library.items.reduce((sum, item) => sum + item.files.length, 0);

function fileSize(bytes) {
  if (!bytes) return '';
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function libraryFile(file) {
  const facts = [file.format, fileSize(file.bytes)].filter(Boolean).join(' · ');
  const digest = file.sha256 ? ` · <span class="digest" title="SHA-256 ${h(file.sha256)}">SHA-256 ${h(file.sha256.slice(0, 12))}…</span>` : ' · <span class="digest">只核对了大小</span>';
  return `<li><a href="${h(file.url)}" rel="noopener" target="_blank">${h(file.label)}</a> <small>${h(facts)}${digest}</small></li>`;
}

function libraryItem(item) {
  const tw = item.region === 'tw';
  const lang = tw ? ' lang="zh-Hant"' : '';
  const year = String(item.published || item.signed || '').slice(0, 4) || '—';
  if (item.compact) {
    const file = item.files[0];
    return `<li class="lib-compact" id="lib-${h(item.id)}"><a href="${h(file.url)}" rel="noopener" target="_blank"${lang}>${h(item.title.replace(/^十二年國民基本教育課程綱要\s*/, ''))}</a> <small>发布 ${h(item.published)} · ${h(file.format)} ${h(fileSize(file.bytes))}</small></li>`;
  }
  const dates = [
    item.edition || '',
    item.signed ? `成文 ${item.signed}` : '',
    item.published ? `发布 ${item.published}` : '',
    item.revised?.length ? `修正 ${item.revised.join('、')}` : '',
  ].filter(Boolean).join(' · ');
  const watch = item.status === 'revision_watch';
  const badges = [
    `<span class="badge">${h(item.kind)}</span>`,
    `<span class="badge"${tw ? ' lang="zh-Hant"' : ''}>${h(item.issuer)}</span>`,
    item.number ? `<span class="badge badge-quiet"${lang}>${h(item.number)}</span>` : '',
    watch ? '<span class="badge badge-accent">修订动态</span>' : '<span class="badge badge-jade">官方原件</span>',
  ].join('');
  const links = [
    `<li><a href="${h(item.page.url)}" rel="noopener" target="_blank"${tw ? ' lang="zh-Hant"' : ''}>${h(item.page.label)} ↗</a></li>`,
    ...(item.links || []).map((link) => `<li><a href="${h(link.url)}" rel="noopener" target="_blank">${h(link.label)} ↗</a></li>`),
    ...item.files.map(libraryFile),
  ].join('');
  return `<li class="row lib-item" id="lib-${h(item.id)}">
  <span class="row-year">${h(year)}</span>
  <div class="row-main">
    <span class="row-title"${lang}>${h(item.title)}</span>
    <span class="row-badges">${badges}</span>
    ${dates ? `<p class="lib-meta">${h(dates)}</p>` : ''}
    ${item.quote ? `<p class="lib-quote">“${h(item.quote)}”</p>` : ''}
    ${item.note ? `<p class="lib-note">${h(item.note)}</p>` : ''}
    <ul class="lib-files">${links}</ul>
  </div>
</li>`;
}

function libraryRegion(library, region) {
  return library.groups.filter((group) => group.region === region).map((group) => {
    const items = library.items.filter((item) => item.group === group.id);
    const compact = items.every((item) => item.compact);
    const list = compact
      ? `<ul class="lib-compact-list">${items.map(libraryItem).join('')}</ul>`
      : `<ol class="rows">${items.map(libraryItem).join('')}</ol>`;
    return `<section class="lib-group" aria-labelledby="group-${h(group.id)}">
  <h3 class="sub" id="group-${h(group.id)}"${region === 'tw' ? ' lang="zh-Hant"' : ''}>${h(group.label)} <small>${items.length} 项</small></h3>
  <p class="panel-note">${h(group.note)}</p>
  ${list}
</section>`;
  }).join('');
}

function librarySubjectPanel(library, subject) {
  const items = library.items.filter((item) => item.region === 'cn' && item.subjects.includes(subject.slug));
  const taiwanLink = subject.slug === 'chinese' ? `<li><a href="/taiwan#library">台湾国语文官方课纲原件</a> <small>${libraryCount(library, 'tw')} 项</small></li>` : '';
  if (!items.length && !taiwanLink) return '';
  return `<section class="panel"><h2>官方补充文件</h2><ul class="plain">${items.map((item) => `<li><a href="/library#lib-${h(item.id)}">${h(item.title)}</a> <small>${h(String(item.published || '').slice(0, 4))} · ${h(item.status === 'revision_watch' ? '修订动态' : item.kind)}</small></li>`).join('')}${taiwanLink}</ul><p class="panel-note">已核对的官方原件或通知页，尚未收入本站全文检索。</p></section>`;
}

function libraryPage(context) {
  const { model, library, catalogCounts } = context;
  const counts = catalogCounts;
  const corpus = `<section class="panel" aria-labelledby="corpus-title">
    <h2 id="corpus-title">本站全文库</h2>
    <p>全文库收课程文件 ${counts.documents} 份：在线原件已核验 ${counts.verified_online} 份，本地扫描件已核验 ${counts.local_verified_scan} 份，只有著录信息 ${counts.metadata_only} 份；其中 ${counts.citation_ready} 份正文可作引文，${counts.ocr_review_pending} 份扫描件的 OCR 仍待复核。按学科查看见 <a href="/#subjects">学科</a>，正文检索见 <a href="/search">检索</a>。</p>
    <p class="panel-note">1950—1992 年部分教学大纲的原件仍在“原件待补目录”中，未补齐前不以其他来源替代。</p>
  </section>`;
  const body = `<div class="wrap subject-page library-page">
  <nav class="crumbs" aria-label="位置"><a href="/">首页</a> / <span>官方文库</span></nav>
  <header class="page-head">
    <h1>官方文库</h1>
    <p class="lede">全文库之外，已核对的官方原件与通知页：大陆课程改革政策、专题指导纲要、尚未入库的课程标准、中职公共基础课程与修订动态；台湾教育部历次课程纲要与课程标准。</p>
    <div class="cov-grid">
      <div class="cov-card"><b>${libraryCount(library, 'cn')}</b><span>大陆补充文件</span></div>
      <div class="cov-card"><b>${libraryCount(library, 'tw')}</b><span>台湾课纲原件</span></div>
      <div class="cov-card"><b>${libraryFileCount(library)}</b><span>已核对文件</span></div>
      <div class="cov-card"><b>${h(library.checked_at.slice(5).replace('-', '.'))}</b><span>${h(library.checked_at.slice(0, 4))} 年核对</span></div>
    </div>
    <p class="panel-note">${h(library.boundary)}</p>
  </header>
  ${corpus}
  <section class="panel" aria-labelledby="cn-library-title">
    <h2 id="cn-library-title">大陆补充文件<small> ${libraryCount(library, 'cn')} 项</small></h2>
    ${libraryRegion(library, 'cn')}
  </section>
  <section class="panel" aria-labelledby="tw-library-title">
    <h2 id="tw-library-title">台湾课程纲要与课程标准原件<small> ${libraryCount(library, 'tw')} 项</small></h2>
    <p class="panel-note">国语文各版本的变化、文言比例与选文见 <a href="/taiwan">台湾国语文</a>。</p>
    ${libraryRegion(library, 'tw')}
  </section>
</div>`;
  return page({ ...context, title: '官方文库', description: '已核对的课程政策、专题指导纲要、中职课程标准、修订动态与台湾历次课程纲要官方原件，逐一记录发布日期、文号、大小与 SHA-256。', pathname: '/library', current: 'library', body, pageKind: 'library' });
}

// ---------- app shells ----------

function shellPage(context, { title, description, pathname, current, kind, noindex }) {
  const body = `<div class="wrap app-shell" data-app="${h(kind)}"><p class="loading">正在载入…</p><noscript><p>此页面需要启用 JavaScript。</p></noscript></div>`;
  return page({ ...context, title, description, pathname, current, body, pageKind: kind, noindex });
}

// ---------- indexes for dynamic pages ----------

function catalogIndex(model) {
  const subjectNames = new Map(model.subjects.map((subject) => [subject.slug, subject.name]));
  return {
    subjects: model.subjects.map((subject) => ({ slug: subject.slug, name: subject.name, api: subject.api_subjects || [] })),
    documents: model.documents.map((document) => ({
      id: document.id,
      t: document.title,
      y: document.year,
      st: document.stage,
      ty: document.document_type,
      s: (model.documentSubjects.get(document.id) || []).map((slug) => [slug, subjectNames.get(slug)]),
    })),
  };
}

function historicalIndex(model) {
  const subjectNames = new Map(model.subjects.map((subject) => [subject.slug, subject.name]));
  return model.items.map((item) => ({
    id: item.id,
    y: item.year,
    t: item.title,
    st: item.stage,
    ty: item.type,
    v: item.volume,
    vt: item.volumeTitle,
    seg: item.segments,
    s: (model.itemSubjects.get(item.id) || []).map((slug) => [slug, subjectNames.get(slug)]),
    c: [...(model.itemConcepts.get(item.id) || [])].slice(0, 12),
  }));
}

// ---------- static files ----------

const HEADERS = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'self'; script-src 'self' https://my.bdfz.net https://pulse.bdfz.net https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://img.bdfz.net https://pulse.bdfz.net; connect-src 'self' https://my.bdfz.net https://nav.bdfz.net https://pulse.bdfz.net https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self' https://my.bdfz.net

/assets/*
  Cache-Control: public, max-age=31536000, immutable
`;

function sitemap(model) {
  const urls = ['/', '/taiwan', '/library', '/search', ...model.subjects.map((subject) => `/s/${subject.slug}`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url><loc>${ORIGIN}${url}</loc></url>`).join('\n')}
</urlset>
`;
}

const ROBOTS = `User-agent: *
Allow: /
Disallow: /admin
Disallow: /api/
Sitemap: ${ORIGIN}/sitemap.xml
`;

// ---------- build ----------

async function hashedAsset(outDir, name, content, assets) {
  const extension = path.extname(name);
  const base = path.basename(name, extension);
  const file = `${base}.${sha(content).slice(0, 12)}${extension}`;
  assets[name] = file;
  await writeFile(path.join(outDir, 'assets', file), content);
  return file;
}

export async function buildSite({ outDir = DIST } = {}) {
  const inputs = await loadInputs();
  const model = buildModel(inputs);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, 'assets'), { recursive: true });
  await mkdir(path.join(outDir, 's'), { recursive: true });

  const assets = {};
  const catalogJson = JSON.stringify(catalogIndex(model));
  const historicalJson = JSON.stringify(historicalIndex(model));
  await hashedAsset(outDir, 'catalog.json', catalogJson, assets);
  await hashedAsset(outDir, 'historical.json', historicalJson, assets);
  const css = await readFile(path.join(ROOT, 'site/styles.css'), 'utf8');
  await hashedAsset(outDir, 'site.css', css, assets);
  const boot = await readFile(path.join(ROOT, 'site/boot.js'), 'utf8');
  await hashedAsset(outDir, 'boot.js', boot, assets);
  const app = (await readFile(path.join(ROOT, 'site/app.js'), 'utf8'))
    .replace('__CATALOG_URL__', `/assets/${assets['catalog.json']}`)
    .replace('__HISTORICAL_URL__', `/assets/${assets['historical.json']}`);
  await hashedAsset(outDir, 'app.js', app, assets);

  const context = { assets, model, aims: inputs.aims, taiwan: inputs.taiwan, library: inputs.library, catalogCounts: inputs.catalog.counts };
  const pages = new Map();
  pages.set('index.html', homePage(context));
  pages.set('taiwan.html', taiwanPage(context));
  pages.set('library.html', libraryPage(context));
  for (const entry of model.perSubject.values()) pages.set(`s/${entry.subject.slug}.html`, subjectPage(context, entry));
  pages.set('search.html', shellPage(context, { title: '全文检索', description: '检索课程标准与教学大纲正文和篇名。', pathname: '/search', current: 'search', kind: 'search' }));
  pages.set('ai.html', shellPage(context, { title: '证据研究', description: '登录后基于已核正文的课程标准研究问答，每个结论都回到原文段落。', pathname: '/ai', current: 'ai', kind: 'ai' }));
  pages.set('discussions.html', shellPage(context, { title: '教师讨论', description: '围绕具体课程文件的教师讨论。', pathname: '/discussions', current: 'discussions', kind: 'discussions' }));
  pages.set('admin.html', shellPage(context, { title: '内容审核', description: '管理员审核。', pathname: '/admin', current: 'admin', kind: 'admin', noindex: true }));
  for (const [file, html] of pages) await writeFile(path.join(outDir, file), html);

  await writeFile(path.join(outDir, '_headers'), HEADERS);
  await writeFile(path.join(outDir, 'robots.txt'), ROBOTS);
  await writeFile(path.join(outDir, 'sitemap.xml'), sitemap(model));
  return { pages: pages.size, assets, documents: model.documents.length, items: model.items.length, model };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = await buildSite();
  delete result.model;
  console.log(`Built dist/: ${result.pages} pages, ${result.documents} documents, ${result.items} historical items.`);
}
