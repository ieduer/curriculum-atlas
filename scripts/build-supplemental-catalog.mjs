import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const host = 'https://www.ictr.edu.cn';
const categories = [
  { label: '义务教育课程标准（2022年版）', url: `${host}/download_center/ywjy.html`, year: 2022, version: '2022年版' },
  { label: '义务教育课程标准（2011年版）', url: `${host}/download_center/yiwu.html`, year: 2011, version: '2011年版' },
  { label: '三类特殊教育学校义务教育课程标准（2016年版）', url: `${host}/download_center/sanlei.html`, year: 2016, version: '2016年版' },
  { label: '全日制义务教育课程标准（实验稿）', url: `${host}/download_center/quanrizhi.html`, year: 2001, version: '实验稿' },
  { label: '普通高中课程标准（2017年版）', url: `${host}/download_center/putong.html`, year: 2017, version: '2017年版' },
  { label: '普通高中课程标准（实验）', url: `${host}/download_center/pt.html`, year: 2003, version: '实验' },
  { label: '普通高中课程标准（2017年版2020年修订）', url: `${host}/download_center/put.html`, year: 2020, version: '2017年版2020年修订' },
  { label: '课程方案', url: `${host}/download_center/fangan.html`, year: null, version: '课程方案' },
];

const inventory = JSON.parse(await readFile(new URL('../.cache/audits/local-pdf-inventory.json', import.meta.url), 'utf8'));
const existingCatalog = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const existingByTitle = new Map(existingCatalog.documents.map((document) => [document.title, document]));
const inventoryByRelativePath = new Map(inventory.records
  .filter((record) => record.root_label === 'ictr')
  .map((record) => [record.relative_path, record]));
const reviewedWorkIdentities = new Map([
  [
    '义务教育课程标准（2011年版）\0义务教育初中科学课程标准（2011年版）',
    {
      document_id: 'moe-2011-12',
      artifact_disposition: 'variant',
      note: '与教育部原始发布件属于同一 2011 年版初中科学课程标准；作为不同扫描件用于页序、图像与 OCR 交叉核对，不构成第二个课程标准版本。',
    },
  ],
]);

function clean(value) {
  return value.replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').trim();
}

function linksFromHtml(html) {
  const links = [];
  const regex = /<a\s+[^>]*href="([^"]+\.(?:pdf|docx?|zip))"[^>]*>[\s\S]*?<div\s+class="t">([\s\S]*?)<\/div>[\s\S]*?<\/a>/gi;
  for (const match of html.matchAll(regex)) {
    links.push({ title: clean(match[2]), url: new URL(match[1], host).href, file_format: match[1].split('.').at(-1).toLowerCase() });
  }
  return links;
}

async function fetchPage(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'BDFZ-Curriculum-Atlas/1.0 source-catalog-verification' },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.text();
}

function pageCount(html) {
  const match = html.match(/id="btn_new"[^>]*data-max="(\d+)"|data-max="(\d+)"[^>]*id="btn_new"/);
  return Number(match?.[1] || match?.[2] || 1);
}

function subjectFor(title) {
  if (title.includes('课程方案')) return '综合';
  const match = title.match(/(?:义务教育|普通高中)(.+?)课程标准/);
  if (!match) return '综合';
  return match[1]
    .replace(/^(?:盲校|聋校|培智学校)/, '')
    .replace(/^小学/, '')
    .replace(/（.*?）/g, '')
    .trim() || '综合';
}

function stageFor(category, title) {
  if (category.label.includes('特殊教育')) return '特殊教育/义务教育';
  if (title.includes('普通高中') || category.label.includes('普通高中')) return '普通高中';
  return '义务教育';
}

function statusFor(category) {
  if (category.version === '2022年版' || category.version === '2017年版2020年修订') return 'current_with_revision_watch';
  if (category.version === '2017年版') return 'superseded_by_2020_revision';
  return 'historical';
}

function stableId(category, title) {
  return `ictr-${createHash('sha256').update(`${category.label}\0${title}`).digest('hex').slice(0, 12)}`;
}

const supplemental = [];
const documentSources = [];
for (const category of categories) {
  const firstHtml = await fetchPage(category.url);
  const pages = [firstHtml];
  for (let page = 2; page <= pageCount(firstHtml); page += 1) {
    pages.push(await fetchPage(`${category.url.replace(/\.html$/, '')}/p/${page}.html`));
  }
  const seen = new Set();
  for (const link of pages.flatMap(linksFromHtml)) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    const filename = decodeURIComponent(new URL(link.url).pathname.split('/').at(-1)).replace(/\.\d{14}(?=\.[^.]+$)/, '');
    const relativePath = `${category.label}/${link.title}.pdf`;
    const local = inventoryByRelativePath.get(relativePath);
    const existing = existingByTitle.get(link.title);
    const reviewedIdentity = reviewedWorkIdentities.get(`${category.label}\0${link.title}`);
    const documentId = reviewedIdentity?.document_id || existing?.id || stableId(category, link.title);
    const accessStatus = local
      ? (local.valid_pdf ? 'verified_online' : 'listed_official_invalid_download')
      : 'metadata_only';
    documentSources.push({
      document_id: documentId,
      provider: '教育部课程教材研究所',
      source_page_url: category.url,
      source_url: link.url,
      checksum_sha256: local?.valid_pdf ? local.sha256 : null,
      access_status: accessStatus,
      is_primary: existing || reviewedIdentity ? 0 : 1,
      ...(reviewedIdentity ? { artifact_disposition: reviewedIdentity.artifact_disposition } : {}),
      note: local?.valid_pdf === false
        ? 'The official endpoint returned a non-PDF zero-filled payload during verification; retained as metadata only.'
        : reviewedIdentity?.note ?? null,
    });
    if (existing || reviewedIdentity) continue;
    supplemental.push({
      id: documentId,
      country: '中国',
      language: 'zh-CN',
      title: link.title,
      subject: subjectFor(link.title),
      stage: stageFor(category, link.title),
      document_type: link.title.includes('课程方案') ? '课程方案' : '课程标准',
      version_label: category.version,
      issued_by: '中华人民共和国教育部',
      issued_date: null,
      published_date: null,
      current_status: statusFor(category),
      source_tier: 'primary_official_institute',
      access_status: accessStatus,
      source_page_url: category.url,
      source_url: link.url,
      file_format: local?.valid_pdf ? 'pdf_local' : link.file_format,
      redistribution: 'metadata_and_search_index_only',
      checksum_sha256: local?.valid_pdf ? local.sha256 : null,
      page_count: local?.pages || null,
      local_cache_path: local?.valid_pdf ? `.cache/sources/ictr/${relativePath}` : null,
      text_quality_status: local?.needs_ocr ? 'ocr_required' : (local?.valid_pdf ? 'official_native_text' : 'unavailable'),
      citation_allowed: Boolean(local?.valid_pdf && !local.needs_ocr),
      note: local?.valid_pdf === false
        ? '课程教材研究所目录已核验，但下载端点在本次检查中返回无效载荷；不生成正文或引文。'
        : `课程教材研究所下载中心“${category.label}”栏目收录。`,
      original_filename: filename,
    });
  }
}

await writeFile(new URL('../data/supplemental-sources.json', import.meta.url), `${JSON.stringify({
  generated_at: new Date().toISOString(),
  source: 'https://www.ictr.edu.cn/download_center/ywjy.html',
  documents: supplemental,
}, null, 2)}\n`);
await writeFile(new URL('../data/document-sources.json', import.meta.url), `${JSON.stringify({
  generated_at: new Date().toISOString(),
  sources: documentSources,
}, null, 2)}\n`);
console.log(`Built ${supplemental.length} supplemental documents and ${documentSources.length} source records.`);
