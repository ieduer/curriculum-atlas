export function ftsQuery(query: string): string {
  const runs = query.normalize('NFKC').match(/[\p{Script=Han}A-Za-z0-9]+/gu) || [];
  const terms: string[] = [];
  for (const run of runs) {
    const characters = [...run];
    if (characters.length < 2) continue;
    if (characters.length <= 6) {
      terms.push(run);
      continue;
    }
    for (let index = 0; index <= characters.length - 4; index += 1) {
      terms.push(characters.slice(index, index + 4).join(''));
    }
  }
  return [...new Set(terms)]
    .slice(0, 32)
    .map((term) => `"${term}"`)
    .join(' OR ');
}
