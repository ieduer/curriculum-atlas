export const DISPLAY_SUBJECT_FACETS = Object.freeze([
  '语文',
  '数学',
  '外语',
  '思想政治与道德法治',
  '历史',
  '历史与社会',
  '地理',
  '科学类',
  '技术',
  '劳动',
  '艺术',
  '体育与健康',
]);

const DISPLAY_FACET_SET = new Set(DISPLAY_SUBJECT_FACETS);
const CANONICAL_MEMBER_ORDER = Object.freeze({
  '语文': ['语文'],
  '数学': ['数学'],
  '外语': ['英语', '俄语', '日语', '西班牙语', '德语', '法语'],
  '思想政治与道德法治': ['思想政治', '思想品德', '品德与生活', '品德与社会', '道德与法治'],
  '历史': ['历史'],
  '历史与社会': ['历史与社会'],
  '地理': ['地理'],
  '科学类': ['科学', '物理', '化学', '生物学'],
  '技术': ['信息科技', '信息技术', '通用技术'],
  '劳动': ['劳动'],
  '艺术': ['艺术', '音乐', '美术'],
  '体育与健康': ['体育与健康'],
});

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function availableCanonicalSubjects(subjects) {
  return new Set((Array.isArray(subjects) ? subjects : [])
    .map((item) => clean(typeof item === 'string' ? item : item?.name))
    .filter(Boolean));
}

export function buildSubjectFacetIndex(conceptGraph, availableSubjects = []) {
  const available = availableCanonicalSubjects(availableSubjects);
  const restrictToAvailable = available.size > 0;
  const controlledFacets = new Set();
  const memberSets = new Map(DISPLAY_SUBJECT_FACETS.map((facet) => [facet, new Set()]));
  const subjectToFacet = new Map(DISPLAY_SUBJECT_FACETS.map((facet) => [facet, facet]));

  for (const item of conceptGraph?.subject_taxonomy || []) {
    const facet = clean(item?.facet);
    if (item?.facet_eligible !== true || item?.entity_kind !== 'subject' || !DISPLAY_FACET_SET.has(facet)) continue;
    const canonical = clean(item.canonical);
    const sourceLabel = clean(item.source_label);
    if (!canonical) continue;
    controlledFacets.add(facet);
    subjectToFacet.set(canonical, facet);
    if (sourceLabel) subjectToFacet.set(sourceLabel, facet);
    if (!restrictToAvailable || available.has(canonical)) memberSets.get(facet).add(canonical);
  }

  const facets = DISPLAY_SUBJECT_FACETS.filter((facet) => controlledFacets.has(facet));
  return {
    facets,
    membersByFacet: Object.fromEntries(facets.map((facet) => {
      const order = CANONICAL_MEMBER_ORDER[facet] || [];
      const priority = new Map(order.map((subject, index) => [subject, index]));
      const members = [...memberSets.get(facet)].sort((left, right) =>
        (priority.get(left) ?? Number.MAX_SAFE_INTEGER) - (priority.get(right) ?? Number.MAX_SAFE_INTEGER)
          || left.localeCompare(right, 'zh-CN'));
      return [facet, members];
    })),
    subjectToFacet: Object.fromEntries(subjectToFacet),
  };
}

export function normalizeSubjectFacet(subjectOrFacet, index) {
  const value = clean(subjectOrFacet);
  if (!value) return null;
  const facet = clean(index?.subjectToFacet?.[value]);
  return index?.facets?.includes(facet) ? facet : null;
}

export function canonicalSubjectsForFacet(facet, index) {
  const normalized = normalizeSubjectFacet(facet, index);
  return normalized ? [...(index.membersByFacet[normalized] || [])] : [];
}

export function planSubjectFacetQueries(facet, index) {
  const normalized = normalizeSubjectFacet(facet, index);
  return canonicalSubjectsForFacet(normalized, index)
    .map((canonicalSubject) => ({ facet: normalized, canonicalSubject }));
}

export function filterDocumentsBySubjectFacet(documents, facet, index) {
  const canonicalSubjects = new Set(canonicalSubjectsForFacet(facet, index));
  if (!canonicalSubjects.size) return [];
  return (Array.isArray(documents) ? documents : []).filter((document) =>
    document?.entity_kind === 'subject'
      && canonicalSubjects.has(clean(document.canonical_subject)));
}

export function controlledSubjectFacetCounts(conceptGraph) {
  const index = buildSubjectFacetIndex(conceptGraph);
  const counts = new Map(index.facets.map((facet) => [facet, 0]));
  for (const episode of conceptGraph?.episodes || []) {
    const subject = episode?.subject;
    const facet = subject?.facet_eligible === true
      && ['subject', 'assessment_subject'].includes(subject?.entity_kind)
      ? clean(subject.facet)
      : '';
    if (counts.has(facet)) counts.set(facet, counts.get(facet) + 1);
  }
  return { subjects: index.facets, counts };
}
