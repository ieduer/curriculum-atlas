export const PUBLIC_SUBJECT_FACETS = [
  '语文',
  '数学',
  '外语',
  '思想政治与道德法治',
  '历史',
  '地理',
  '科学类',
  '技术',
  '劳动',
  '艺术',
  '体育与健康',
] as const;

export function normalizePublicSubjectQuery(subject: string): string {
  return subject === '历史与社会' ? '历史' : subject;
}

export function secondarySubjectIdentity(subject: string): string {
  return normalizePublicSubjectQuery(subject) === '历史' ? '历史与社会' : subject;
}

type SubjectFacetRow = {
  name: string;
  documentCount?: number;
  firstYear?: number | null;
  lastYear?: number | null;
};

export function mergePublicSubjectFacetRows(rows: SubjectFacetRow[]): SubjectFacetRow[] {
  const merged = new Map<string, SubjectFacetRow>();
  for (const row of rows) {
    const name = normalizePublicSubjectQuery(row.name);
    const current = merged.get(name);
    const firstYears = [current?.firstYear, row.firstYear].filter((value): value is number => Number.isFinite(value));
    const lastYears = [current?.lastYear, row.lastYear].filter((value): value is number => Number.isFinite(value));
    merged.set(name, {
      name,
      documentCount: Number(current?.documentCount || 0) + Number(row.documentCount || 0),
      firstYear: firstYears.length ? Math.min(...firstYears) : null,
      lastYear: lastYears.length ? Math.max(...lastYears) : null,
    });
  }
  return PUBLIC_SUBJECT_FACETS.map((name) => merged.get(name)).filter((row): row is SubjectFacetRow => Boolean(row));
}
