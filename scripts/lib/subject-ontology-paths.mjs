export const SUBJECT_ONTOLOGY_ROOT_PATH = 'data/ontologies';
export const SUBJECT_ONTOLOGY_INDEX_PATH = `${SUBJECT_ONTOLOGY_ROOT_PATH}/index.json`;

export const SUBJECT_ONTOLOGY_FACET_SLUGS = Object.freeze([
  'chinese-language',
  'mathematics',
  'foreign-languages',
  'politics-morality-law',
  'history',
  'history-and-society',
  'geography',
  'science',
  'technology',
  'labor',
  'arts',
  'physical-education-health',
]);

export const SUBJECT_ONTOLOGY_SCOPE_PATH_PATTERN_SOURCE = `^data/ontologies/(${SUBJECT_ONTOLOGY_FACET_SLUGS.join('|')})/[a-z0-9][a-z0-9._-]*\\.json$`;
const SUBJECT_ONTOLOGY_SCOPE_PATH_PATTERN = new RegExp(SUBJECT_ONTOLOGY_SCOPE_PATH_PATTERN_SOURCE, 'u');

export function canonicalSubjectOntologyFacetDirectory(facetSlug) {
  if (!SUBJECT_ONTOLOGY_FACET_SLUGS.includes(facetSlug)) {
    throw new Error(`unsupported subject ontology facet slug: ${facetSlug || '<unset>'}`);
  }
  return `${SUBJECT_ONTOLOGY_ROOT_PATH}/${facetSlug}`;
}

export function assertCanonicalSubjectOntologyScopePath(value, {
  facetSlug = null,
  label = 'subject ontology scope path',
} = {}) {
  if (typeof value !== 'string' || !SUBJECT_ONTOLOGY_SCOPE_PATH_PATTERN.test(value)) {
    throw new Error(`${label} must match ${SUBJECT_ONTOLOGY_SCOPE_PATH_PATTERN_SOURCE}: ${value || '<unset>'}`);
  }
  if (facetSlug !== null && !value.startsWith(`${canonicalSubjectOntologyFacetDirectory(facetSlug)}/`)) {
    throw new Error(`${label} crosses the canonical ${facetSlug} facet directory: ${value}`);
  }
  return value;
}

export function isCanonicalSubjectOntologyScopePath(value, options = {}) {
  try {
    assertCanonicalSubjectOntologyScopePath(value, options);
    return true;
  } catch {
    return false;
  }
}
