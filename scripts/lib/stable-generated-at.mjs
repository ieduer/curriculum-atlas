import { isDeepStrictEqual } from 'node:util';

function withoutGeneratedAt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { generated_at: _generatedAt, ...rest } = value;
  return rest;
}

export function preserveGeneratedAt(candidate, existing) {
  if (
    typeof existing?.generated_at === 'string'
    && existing.generated_at.length > 0
    && isDeepStrictEqual(withoutGeneratedAt(candidate), withoutGeneratedAt(existing))
  ) {
    candidate.generated_at = existing.generated_at;
  }
  return candidate;
}
