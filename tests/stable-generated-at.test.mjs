import assert from 'node:assert/strict';
import test from 'node:test';

import { preserveGeneratedAt } from '../scripts/lib/stable-generated-at.mjs';

test('generated timestamps remain stable when the governed payload is unchanged', () => {
  const candidate = { schema_version: 1, generated_at: 'new', payload: { count: 2 } };
  const existing = { schema_version: 1, generated_at: 'old', payload: { count: 2 } };

  assert.equal(preserveGeneratedAt(candidate, existing).generated_at, 'old');
});

test('generated timestamps advance when governed content changes', () => {
  const candidate = { schema_version: 1, generated_at: 'new', payload: { count: 3 } };
  const existing = { schema_version: 1, generated_at: 'old', payload: { count: 2 } };

  assert.equal(preserveGeneratedAt(candidate, existing).generated_at, 'new');
});

test('malformed prior timestamps never replace a fresh timestamp', () => {
  const candidate = { schema_version: 1, generated_at: 'new', payload: { count: 2 } };
  const existing = { schema_version: 1, generated_at: '', payload: { count: 2 } };

  assert.equal(preserveGeneratedAt(candidate, existing).generated_at, 'new');
});
