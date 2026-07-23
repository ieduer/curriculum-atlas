export const CURRICULUM_STAGES = Object.freeze([
  Object.freeze({
    id: 'late-qing-school-regulations',
    label: '清末学堂章程',
    shortLabel: '清末章程',
    start: 1902,
    end: 1911,
    evidenceBasis: '1902、1904 学堂章程及 1909 课程变通文件',
  }),
  Object.freeze({
    id: 'early-republic-curriculum-formation',
    label: '民初法令与课程建制',
    shortLabel: '民初建制',
    start: 1912,
    end: 1922,
    evidenceBasis: '1912–1919 学校法令、施行规则与课程标准，以及 1922 学校系统改革令',
  }),
  Object.freeze({
    id: 'new-school-system-syllabi',
    label: '新学制课程纲要',
    shortLabel: '新学制纲要',
    start: 1923,
    end: 1928,
    evidenceBasis: '1923 新学制课程纲要及各科纲要',
  }),
  Object.freeze({
    id: 'curriculum-standard-compilation',
    label: '课程标准编订与修正',
    shortLabel: '课标编订',
    start: 1929,
    end: 1936,
    evidenceBasis: '1929 暂行课程标准、1932 课程标准与 1936 修正课程标准',
  }),
  Object.freeze({
    id: 'wartime-postwar-revisions',
    label: '战时调整与战后修订',
    shortLabel: '战时·战后修订',
    start: 1937,
    end: 1949,
    evidenceBasis: '1940–1942 战时编订、修正与草案，以及 1948 修订课程标准',
  }),
  Object.freeze({
    id: 'national-curriculum-foundation',
    label: '国家课程起点',
    shortLabel: '国家课程起点',
    start: 1950,
    end: 1977,
    evidenceBasis: '1950 起课程标准及后续教学大纲目录观察',
  }),
  Object.freeze({
    id: 'restoration-and-reconstruction',
    label: '恢复与重建',
    shortLabel: '恢复与重建',
    start: 1978,
    end: 2000,
    evidenceBasis: '1978–2000 课程与教学大纲目录观察',
  }),
  Object.freeze({
    id: 'new-curriculum-reform',
    label: '新课程改革',
    shortLabel: '新课程改革',
    start: 2001,
    end: 2010,
    evidenceBasis: '2001 起课程标准目录与正文观察',
  }),
  Object.freeze({
    id: 'core-competency-transition',
    label: '核心素养转向',
    shortLabel: '核心素养转向',
    start: 2011,
    end: 2021,
    evidenceBasis: '2011–2021 课程标准目录与正文观察',
  }),
  Object.freeze({
    id: 'competency-oriented-reconstruction',
    label: '素养导向重构',
    shortLabel: '素养导向重构',
    start: 2022,
    end: 2022,
    evidenceBasis: '2022 义务教育课程方案与课程标准观察',
  }),
]);

export function curriculumStageForYear(year) {
  const value = Number(year);
  return CURRICULUM_STAGES.find((stage) => value >= stage.start && value <= stage.end) || null;
}
