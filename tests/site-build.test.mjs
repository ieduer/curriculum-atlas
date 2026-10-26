import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { buildSite, documentYear, stageKey, typeKey } from '../scripts/build-site.mjs';

const root = new URL('../', import.meta.url);
const readJson = async (relative) => JSON.parse(await readFile(new URL(relative, root), 'utf8'));

// Canonical subjects the Worker accepts as /api/search identities (taxonomy_entity_kind = subject).
const SEARCH_IDENTITIES = new Set(['体育与健康', '俄语', '信息技术', '信息科技', '劳动', '化学', '历史', '历史与社会', '品德与生活', '品德与社会', '地理', '德语', '思想品德', '思想政治', '数学', '日语', '法语', '物理', '生物学', '科学', '美术', '艺术', '英语', '西班牙语', '语文', '通用技术', '道德与法治', '音乐']);

let outDir;
let result;

before(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'curriculum-site-'));
  result = await buildSite({ outDir });
});

after(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

test('document years follow revision, edition, issue date, then batch rules', () => {
  assert.equal(documentYear({ id: 'moe-hs-2020-02', title: '普通高中语文课程标准（2017年版2020年修订）', issued_date: '2020-05-11' }), 2020);
  assert.equal(documentYear({ id: 'ictr-a71e3780f934', title: '普通高中语文课程标准（2017年版）', issued_date: '2018-01-05' }), 2017);
  assert.equal(documentYear({ id: 'ictr-6c6df9d121ac', title: '义务教育劳动课程标准(2022年版)' }), 2022);
  assert.equal(documentYear({ id: 'ictr-afedc894b8c4', title: '全日制义务教育语文课程标准（实验稿）' }), 2001);
  assert.equal(documentYear({ id: 'ictr-0bcfe4b915df', title: '普通高中语文课程标准（实验）' }), 2003);
  assert.equal(documentYear({ id: 'ictr-cfb2a39a2016', title: '聋校义务教育课程设置实验方案（2007年）' }), 2007);
  assert.equal(documentYear({ id: 'policy-1950-1993-overview', title: '中国基础教育课程沿革官方概述（1950—1993）' }), null);
});

test('stage and type labels normalise source vocabularies', () => {
  assert.equal(stageKey('特殊教育/义务教育'), '特殊教育');
  assert.equal(stageKey('普通高中/高考'), '高考');
  assert.equal(stageKey('小学—中学'), '综合');
  assert.equal(typeKey('学制章程'), '章程法令');
  assert.equal(typeKey('授课时数表'), '课程计划');
});

test('every subject has its own page and every catalog document reaches at least one page', async () => {
  const { subjects } = await readJson('content/subjects.json');
  const pages = await readdir(path.join(outDir, 's'));
  assert.deepEqual(pages.sort(), subjects.map((subject) => `${subject.slug}.html`).sort());
  const orphans = result.model.documents.filter((document) => !(result.model.documentSubjects.get(document.id) || []).length);
  assert.deepEqual(orphans.map((document) => document.id), []);
  for (const subject of subjects) {
    const entry = result.model.perSubject.get(subject.slug);
    assert.ok(entry.docs.length + entry.historical.length > 0, `${subject.slug} has no rows`);
    for (const name of subject.api_subjects || []) assert.ok(SEARCH_IDENTITIES.has(name), `${subject.slug}: ${name} is not a search identity`);
  }
});

test('historical item identities match the reader package rule', async () => {
  const century = await readJson('public/data/century-observation-layer.json');
  const pre2001 = await readJson('public/data/pre2001-subject-detail-observation-layer.json');
  const merged = pre2001.items.filter((item) => item.source_item_id).length;
  assert.equal(result.model.items.length, century.items.length + pre2001.items.length - merged);
  assert.ok(result.model.items.every((item) => /^(embedded-century|pre2001-item):/.test(item.id)));
});

test('pages are static: no inline scripts, no star-map data, no API calls in HTML', async () => {
  const files = ['index.html', 'taiwan.html', 'library.html', 'search.html', ...(await readdir(path.join(outDir, 's'))).map((file) => `s/${file}`)];
  for (const file of files) {
    const html = await readFile(path.join(outDir, file), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${file} has an inline script`);
    assert.doesNotMatch(html, /\/data\/[a-z-]+\.json/, `${file} references retired star-map data`);
    assert.doesNotMatch(html, /fetch\(|\/api\/(meta|documents\?|insights)/, `${file} calls the API`);
  }
  const index = await readFile(path.join(outDir, 'index.html'));
  assert.ok(index.length < 150_000, `index.html is ${index.length} bytes`);
  const assets = await readdir(path.join(outDir, 'assets'));
  assert.ok(assets.every((file) => /\.[0-9a-f]{12}\.(js|css|json)$/.test(file)), 'assets are content-hashed');
});

test('whole-person aims cite known dimensions and existing catalog documents', async () => {
  const aims = await readJson('content/whole-person-aims.json');
  const keys = new Set(aims.dimensions.map((dimension) => dimension.key));
  const ids = new Set(result.model.documents.map((document) => document.id));
  for (const region of aims.regions) {
    const years = region.milestones.map((milestone) => milestone.year);
    assert.deepEqual(years, [...years].sort((left, right) => left - right), `${region.id} milestones are chronological`);
    for (const milestone of region.milestones) {
      assert.ok(milestone.quote && milestone.source?.label, `${milestone.id} has a quote and source`);
      for (const key of Object.keys(milestone.cells)) assert.ok(keys.has(key), `${milestone.id}: unknown dimension ${key}`);
      if (milestone.source.document_id) assert.ok(ids.has(milestone.source.document_id), `${milestone.id}: unknown document`);
    }
  }
});

test('Taiwan content keeps sources, ratios and reading-list mappings consistent', async () => {
  const taiwan = await readJson('content/taiwan-guowen.json');
  for (const track of taiwan.tracks) {
    for (const version of track.versions) {
      assert.ok(['official', 'research', 'press'].includes(version.confidence));
      for (const source of version.sources) assert.ok(taiwan.sources[source], `${version.title}: missing source ${source}`);
    }
  }
  for (const row of [...taiwan.classical_ratio.senior, ...taiwan.classical_ratio.junior]) {
    assert.ok(row.min >= 0 && row.max <= 100 && row.min < row.max);
    assert.ok(taiwan.sources[row.source]);
  }
  assert.equal(taiwan.readings.list101.length, 30);
  assert.equal(taiwan.readings.list108.length, 15);
  const numbers = new Set(taiwan.readings.list101.map((row) => row.n));
  for (const row of taiwan.readings.list108) {
    if (row.relation === 'new') assert.equal(row.match, null);
    else assert.ok(numbers.has(row.match), `${row.title} maps to a 101 entry`);
  }
  const html = await readFile(path.join(outDir, 'taiwan.html'), 'utf8');
  assert.match(html, /id="src-k12-108"/);
});

test('official library lists only verified official originals with their digests', async () => {
  const library = await readJson('content/official-library.json');
  const groups = new Map(library.groups.map((group) => [group.id, group]));
  const subjects = new Set((await readJson('content/subjects.json')).subjects.map((subject) => subject.slug));
  const taiwan = await readJson('content/taiwan-guowen.json');
  const versions = new Set(taiwan.tracks.flatMap((track) => track.versions.map((version) => `${track.id}:${version.year}`)));
  const ids = new Set();
  for (const item of library.items) {
    assert.ok(!ids.has(item.id), `${item.id} is unique`);
    ids.add(item.id);
    assert.equal(groups.get(item.group)?.region, item.region, `${item.id} sits in a group of its region`);
    assert.ok(['official_original', 'revision_watch'].includes(item.status));
    assert.match(item.page.url, /^https?:\/\/(www\.moe\.gov\.cn|www\.gov\.cn|education\.news\.cn|www\.naer\.edu\.tw|www\.k12ea\.gov\.tw|edu\.law\.moe\.gov\.tw)\//, `${item.id}: publisher page`);
    for (const subject of item.subjects) assert.ok(subjects.has(subject), `${item.id}: unknown subject ${subject}`);
    for (const [track, year] of item.tracks || []) assert.ok(versions.has(`${track}:${year}`), `${item.id}: no Taiwan version ${track} ${year}`);
    for (const file of item.files) {
      assert.ok(file.bytes > 0, `${item.id}: ${file.label} size`);
      if (file.format === 'RAR') assert.equal(file.sha256, null);
      else assert.match(file.sha256, /^[0-9a-f]{64}$/, `${item.id}: ${file.label} digest`);
    }
    if (item.status === 'official_original' && item.region === 'cn') assert.match(item.page.url, /moe\.gov\.cn|gov\.cn/);
  }
  const html = await readFile(path.join(outDir, 'library.html'), 'utf8');
  for (const item of library.items) assert.match(html, new RegExp(`id="lib-${item.id}"`));
  const chinese = await readFile(path.join(outDir, 's/chinese.html'), 'utf8');
  assert.match(chinese, /href="\/library#lib-cn-2020-zz-three"/);
  assert.match(chinese, /href="\/taiwan#library"/);
  const taiwanHtml = await readFile(path.join(outDir, 'taiwan.html'), 'utf8');
  assert.match(taiwanHtml, /href="#lib-tw-hs-101"/);
  assert.match(taiwanHtml, /id="lib-tw-hs-101"/);
  const sitemap = await readFile(path.join(outDir, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /\/library<\/loc>/);
});
