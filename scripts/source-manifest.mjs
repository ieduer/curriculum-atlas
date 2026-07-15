import { readFile } from 'node:fs/promises';

const moe2022Base = 'https://hudong.moe.gov.cn/srcsite/A26/s8001/202204/';
const moe2011Base = 'https://hudong.moe.gov.cn/srcsite/A26/s8001/201112/';
const neea2019Base = 'https://www.neea.edu.cn/res/Home/1901/';

const common = {
  country: '中国',
  language: 'zh-CN',
  source_tier: 'primary_official',
  access_status: 'verified_online',
  redistribution: 'metadata_and_search_index_only',
};

function documentRecord(series, index, spec, fields) {
  const [subject, title, filename] = spec;
  return {
    id: `${series}-${String(index + 1).padStart(2, '0')}`,
    subject,
    title,
    filename,
    ...common,
    ...fields,
  };
}

const moe2022 = [
  ['课程方案', '义务教育课程方案（2022年版）', 'W020220420582343217634.pdf'],
  ['道德与法治', '义务教育道德与法治课程标准（2022年版）', 'W020220420582343475848.pdf'],
  ['语文', '义务教育语文课程标准（2022年版）', 'W020220420582344386456.pdf'],
  ['历史', '义务教育历史课程标准（2022年版）', 'W020220420582345700037.pdf'],
  ['数学', '义务教育数学课程标准（2022年版）', 'W020220510531636118932.pdf'],
  ['英语', '义务教育英语课程标准（2022年版）', 'W020220420582349487953.pdf'],
  ['日语', '义务教育日语课程标准（2022年版）', 'W020230605524874315398.pdf'],
  ['俄语', '义务教育俄语课程标准（2022年版）', 'W020220420582353002089.pdf'],
  ['地理', '义务教育地理课程标准（2022年版）', 'W020220420582354066450.pdf'],
  ['科学', '义务教育科学课程标准（2022年版）', 'W020220420582355009892.pdf'],
  ['物理', '义务教育物理课程标准（2022年版）', 'W020220420582357585169.pdf'],
  ['化学', '义务教育化学课程标准（2022年版）', 'W020230605524875861384.pdf'],
  ['生物学', '义务教育生物学课程标准（2022年版）', 'W020220420582359998122.pdf'],
  ['信息科技', '义务教育信息科技课程标准（2022年版）', 'W020220420582361024968.pdf'],
  ['体育与健康', '义务教育体育与健康课程标准（2022年版）', 'W020220420582362336303.pdf'],
  ['艺术', '义务教育艺术课程标准（2022年版）', 'W020220420582364678888.pdf'],
  ['劳动', '义务教育劳动课程标准（2022年版）', 'W020220420582367012450.pdf'],
].map((spec, index) => documentRecord('moe-2022', index, spec, {
  stage: '义务教育',
  document_type: index === 0 ? '课程方案' : '课程标准',
  version_label: '2022年版',
  issued_by: '中华人民共和国教育部',
  issued_date: '2022-04-08',
  published_date: '2022-04-21',
  current_status: 'current_with_revision_watch',
  source_page_url: `${moe2022Base}t20220420_619921.html`,
  source_url: `${moe2022Base}${spec[2]}`,
  file_format: 'pdf',
}));

const moe2011 = [
  ['语文', '义务教育语文课程标准（2011年版）', 'W020220418401378158281.pdf'],
  ['英语', '义务教育英语课程标准（2011年版）', 'W020220418401378728645.pdf'],
  ['日语', '义务教育日语课程标准（2011年版）', 'W020220418401379805960.pdf'],
  ['俄语', '义务教育俄语课程标准（2011年版）', 'W020220418401380521630.pdf'],
  ['品德与生活', '义务教育品德与生活课程标准（2011年版）', 'W020220418401381008557.pdf'],
  ['品德与社会', '义务教育品德与社会课程标准（2011年版）', 'W020220418401381189926.pdf'],
  ['思想品德', '义务教育思想品德课程标准（2011年版）', 'W020220418401381408819.pdf'],
  ['数学', '义务教育数学课程标准（2011年版）', 'W020220418401382030426.pdf'],
  ['物理', '义务教育物理课程标准（2011年版）', 'W020220418401383156396.pdf'],
  ['化学', '义务教育化学课程标准（2011年版）', 'W020220418401383699026.pdf'],
  ['生物学', '义务教育生物学课程标准（2011年版）', 'W020220418401384311181.pdf'],
  ['科学', '义务教育小学科学课程标准（2011年版）', 'W020220418401384948134.pdf'],
  ['历史', '义务教育历史课程标准（2011年版）', 'W020220418401385879509.pdf'],
  ['地理', '义务教育地理课程标准（2011年版）', 'W020220418401386310077.pdf'],
  ['历史与社会', '义务教育历史与社会课程标准（2011年版）', 'W020220418401386580231.pdf'],
  ['艺术', '义务教育艺术课程标准（2011年版）', 'W020220418401387203763.pdf'],
  ['音乐', '义务教育音乐课程标准（2011年版）', 'W020220418401387878443.pdf'],
  ['美术', '义务教育美术课程标准（2011年版）', 'W020220418401388154397.pdf'],
  ['体育与健康', '义务教育体育与健康课程标准（2011年版）', 'W020220418401388381349.pdf'],
].map((spec, index) => documentRecord('moe-2011', index, spec, {
  stage: '义务教育',
  document_type: '课程标准',
  version_label: '2011年版',
  issued_by: '中华人民共和国教育部',
  issued_date: '2011-12-28',
  current_status: 'superseded',
  source_page_url: `${moe2011Base}t20111228_167340.html`,
  source_url: `${moe2011Base}${spec[2]}`,
  file_format: 'pdf',
}));

const highSchoolSpecs = [
  ['课程方案', '普通高中课程方案（2017年版2020年修订）'],
  ['语文', '普通高中语文课程标准（2017年版2020年修订）'],
  ['数学', '普通高中数学课程标准（2017年版2020年修订）'],
  ['英语', '普通高中英语课程标准（2017年版2020年修订）'],
  ['思想政治', '普通高中思想政治课程标准（2017年版2020年修订）'],
  ['历史', '普通高中历史课程标准（2017年版2020年修订）'],
  ['地理', '普通高中地理课程标准（2017年版2020年修订）'],
  ['物理', '普通高中物理课程标准（2017年版2020年修订）'],
  ['化学', '普通高中化学课程标准（2017年版2020年修订）'],
  ['生物学', '普通高中生物学课程标准（2017年版2020年修订）'],
  ['信息技术', '普通高中信息技术课程标准（2017年版2020年修订）'],
  ['通用技术', '普通高中通用技术课程标准（2017年版2020年修订）'],
  ['艺术', '普通高中艺术课程标准（2017年版2020年修订）'],
  ['音乐', '普通高中音乐课程标准（2017年版2020年修订）'],
  ['美术', '普通高中美术课程标准（2017年版2020年修订）'],
  ['体育与健康', '普通高中体育与健康课程标准（2017年版2020年修订）'],
  ['日语', '普通高中日语课程标准（2017年版2020年修订）'],
  ['俄语', '普通高中俄语课程标准（2017年版2020年修订）'],
  ['德语', '普通高中德语课程标准（2017年版2020年修订）'],
  ['法语', '普通高中法语课程标准（2017年版2020年修订）'],
  ['西班牙语', '普通高中西班牙语课程标准（2017年版2020年修订）'],
];

const highSchool2020 = highSchoolSpecs.map((spec, index) => documentRecord('moe-hs-2020', index, [spec[0], spec[1], null], {
  stage: '普通高中',
  document_type: index === 0 ? '课程方案' : '课程标准',
  version_label: '2017年版2020年修订',
  issued_by: '中华人民共和国教育部',
  issued_date: '2020-05-11',
  published_date: '2020-06-03',
  current_status: 'current_with_revision_watch',
  source_page_url: 'https://hudong.moe.gov.cn/srcsite/A26/s8001/202006/t20200603_462199.html',
  source_url: 'https://hudong.moe.gov.cn/srcsite/A26/s8001/202006/W020200603315372317586.zip',
  file_format: 'pdf_in_zip',
  archive_member_prefix: String(index + 1).padStart(2, '0'),
}));

const neeaSpecs = [
  ['考试大纲', '2019年普通高等学校招生全国统一考试大纲（总纲）', '86158689c683971ff0d198b6a80e5eb3.pdf'],
  ['语文', '2019年普通高等学校招生全国统一考试大纲：语文', 'ae5f3abdac517d2902c1ee902c10e9b4.pdf'],
  ['文科数学', '2019年普通高等学校招生全国统一考试大纲：文科数学', '60735dcff3fd04bb538e0150a86f764e.pdf'],
  ['理科数学', '2019年普通高等学校招生全国统一考试大纲：理科数学', 'd722242b1b7b3b4eed7d217dc782789a.pdf'],
  ['汉语', '2019年普通高等学校招生全国统一考试大纲：汉语', 'e482ae98711e5138dcaa4e23c0268323.pdf'],
  ['物理', '2019年普通高等学校招生全国统一考试大纲：物理', 'c1e68939802423ddaadbeb6745afdf05.pdf'],
  ['化学', '2019年普通高等学校招生全国统一考试大纲：化学', '37917dd480ad101f28e16722f6b63052.pdf'],
  ['生物', '2019年普通高等学校招生全国统一考试大纲：生物', '447ff4f561e93bc2ebcb744703fc584e.pdf'],
  ['思想政治', '2019年普通高等学校招生全国统一考试大纲：思想政治', '53e4c4127f17bdf6ec8aa93f4de806f0.pdf'],
  ['历史', '2019年普通高等学校招生全国统一考试大纲：历史', 'dfaa2ce3923702b19c147b03fccb9c9f.pdf'],
  ['地理', '2019年普通高等学校招生全国统一考试大纲：地理', '690da6e735a889c39cfdf8bf4029c18a.pdf'],
  ['英语', '2019年普通高等学校招生全国统一考试大纲：英语', 'd15ec0514666ac280810099f9595b557.pdf'],
];

const neea2019 = neeaSpecs.map((spec, index) => documentRecord('neea-2019', index, spec, {
  stage: '普通高中/高考',
  document_type: '考试大纲',
  version_label: '2019年版',
  issued_by: '教育部考试中心',
  issued_date: '2019-01-31',
  current_status: 'historical',
  source_page_url: 'https://www.neea.edu.cn/html1/report/19012/153-1.htm',
  source_url: `${neea2019Base}${spec[2]}`,
  file_format: 'pdf',
}));

const policyRecords = [
  {
    id: 'policy-1950-1993-overview',
    title: '中国基础教育课程沿革官方概述（1950—1993）',
    subject: '综合', stage: '基础教育', document_type: '官方历史概述',
    version_label: '历史综述', issued_by: '中华人民共和国教育部',
    issued_date: null, current_status: 'historical_reference',
    source_page_url: 'https://www.moe.gov.cn/s78/A06/s8345/moe_719/tnull_3624.html',
    source_url: 'https://www.moe.gov.cn/s78/A06/s8345/moe_719/tnull_3624.html', file_format: 'html',
    note: '用于定位1950课程标准及1956、1963、1978、1986、1992教学大纲沿革；未取得原件者不提供推断全文。',
  },
  {
    id: 'policy-2001-reform-outline', title: '基础教育课程改革纲要（试行）', subject: '综合', stage: '基础教育',
    document_type: '改革纲要', version_label: '2001试行', issued_by: '中华人民共和国教育部', issued_date: '2001-06-08',
    current_status: 'historical_reference', source_page_url: 'https://www.moe.gov.cn/srcsite/A26/jcj_kcjcgh/200106/t20010608_167343.html',
    source_url: 'https://www.moe.gov.cn/srcsite/A26/jcj_kcjcgh/200106/t20010608_167343.html', file_format: 'html',
  },
  {
    id: 'policy-2003-hs-standards', title: '普通高中课程方案和课程标准实验稿通知', subject: '综合', stage: '普通高中',
    document_type: '发布通知', version_label: '2003实验', issued_by: '中华人民共和国教育部', issued_date: '2003-03-31',
    current_status: 'superseded', source_page_url: 'https://www.moe.gov.cn/srcsite/A26/s8001/200303/t20030331_167349.html',
    source_url: 'https://www.moe.gov.cn/srcsite/A26/s8001/200303/t20030331_167349.html', file_format: 'html',
  },
  {
    id: 'policy-2020-gaokao-evaluation', title: '中国高考评价体系发布说明', subject: '考试评价', stage: '普通高中/高考',
    document_type: '评价体系说明', version_label: '2020', issued_by: '中华人民共和国教育部', issued_date: '2020-01-07',
    current_status: 'current_reference', source_page_url: 'https://www.moe.gov.cn/jyb_xwfb/gzdt_gzdt/s5987/202001/t20200107_414611.html',
    source_url: 'https://www.moe.gov.cn/jyb_xwfb/gzdt_gzdt/s5987/202001/t20200107_414611.html', file_format: 'html',
  },
  {
    id: 'policy-2020-evaluation-reform', title: '深化新时代教育评价改革总体方案', subject: '考试评价', stage: '各学段',
    document_type: '改革方案', version_label: '2020', issued_by: '中共中央、国务院', issued_date: '2020-10-13',
    current_status: 'current_reference', source_page_url: 'https://www.gov.cn/zhengce/2020-10/13/content_5551032.htm',
    source_url: 'https://www.gov.cn/zhengce/2020-10/13/content_5551032.htm', file_format: 'html',
  },
  {
    id: 'policy-2000-hs-syllabi', title: '2000—2002年普通高中课程计划与教学大纲修订背景', subject: '综合', stage: '普通高中',
    document_type: '官方修订说明', version_label: '2000—2002', issued_by: '中华人民共和国教育部', issued_date: '2002-06-01',
    current_status: 'historical_reference', source_page_url: 'https://www.moe.gov.cn/s78/A06/jcys_left/s3732/s3328/201001/t20100128_82017.html',
    source_url: 'https://www.moe.gov.cn/s78/A06/jcys_left/s3732/s3328/201001/t20100128_82017.html', file_format: 'html',
  },
  {
    id: 'catalog-legacy-originals', title: '1950—1992课程标准/教学大纲原件待补目录', subject: '综合', stage: '基础教育',
    document_type: '资料缺口目录', version_label: '1950—1992', issued_by: '资料编目组', issued_date: null,
    current_status: 'missing_primary_files', source_page_url: 'https://www.moe.gov.cn/s78/A06/s8345/moe_719/tnull_3624.html',
    source_url: 'https://www.moe.gov.cn/s78/A06/s8345/moe_719/tnull_3624.html', file_format: 'catalog',
    note: '仅记录教育部官方沿革中明确出现的版本；取得可核验原件前不生成章节、引文或差异结论。',
  },
  {
    id: 'catalog-revision-watch', title: '现行课程标准修订动态观察', subject: '综合', stage: '基础教育',
    document_type: '更新监测', version_label: '持续更新', issued_by: '资料编目组', issued_date: null,
    current_status: 'revision_watch', source_page_url: 'https://www.moe.gov.cn/', source_url: 'https://www.moe.gov.cn/', file_format: 'catalog',
    note: '现行标签按教育部公开目录判定；已知处于修订中的版本单独标注，不将修订意向误报为已发布标准。',
  },
].map((record) => ({ ...common, access_status: record.current_status === 'missing_primary_files' ? 'metadata_only' : 'verified_online', redistribution: 'metadata_and_excerpt_only', ...record }));

const supplementalDocuments = JSON.parse(await readFile(new URL('../data/supplemental-sources.json', import.meta.url), 'utf8')).documents;
const localCompendia = JSON.parse(await readFile(new URL('../data/local-compendia.json', import.meta.url), 'utf8')).documents;

export const sourceManifest = [
  ...moe2022,
  ...moe2011,
  ...highSchool2020,
  ...neea2019,
  ...policyRecords,
  ...supplementalDocuments,
  ...localCompendia,
];
