import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const schema = await readFile(new URL('data/candidate-observation-layer.schema.json', root), 'utf8').then(JSON.parse);

test('the formal candidate schema fixes every fail-closed star claim', () => {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.properties.observation.properties.semantic.const, false);
  assert.equal(schema.properties.coverage.properties.negative_claim_eligible.const, false);
  assert.equal(schema.properties.claim_policy.properties.display_level.const, 'uniform_star');
  assert.equal(schema.allOf[0].then.properties.visibility_facets.maxItems, 0);
  assert.equal(schema.allOf[0].else.properties.visibility_facets.minItems, 1);
  for (const field of [
    'quotation_allowed',
    'semantic_relation_allowed',
    'historical_superlative_allowed',
    'first_appearance_allowed',
    'disappearance_allowed',
  ]) assert.equal(schema.properties.claim_policy.properties[field].const, false);
});
