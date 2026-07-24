import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const [budget, receipt, atlas, app] = await Promise.all([
  readFile(new URL('data/star-map-performance-budget.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('data/star-map-performance-validation.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/atlas.js', root), 'utf8'),
  readFile(new URL('public/app.js', root), 'utf8'),
]);

test('performance budgets are non-overridable and preview runtime blocks production', () => {
  assert.equal(budget.release_policy.static_failure_blocks_preview, true);
  assert.equal(budget.release_policy.static_failure_blocks_production, true);
  assert.equal(budget.release_policy.preview_runtime_failure_blocks_production, true);
  assert.equal(budget.release_policy.manual_override_allowed, false);
});

test('the checked-in static performance receipt passes all budgets', () => {
  assert.equal(receipt.budget_id, budget.budget_id);
  assert.equal(receipt.release_decision, 'pass');
  assert.equal(receipt.deployment_allowed, true);
  assert.ok(receipt.checks.every((item) => item.passed));
});

test('the Canvas publishes bounded runtime diagnostics without adding a second view', () => {
  assert.match(atlas, /performanceSnapshot\(\)/);
  assert.match(atlas, /this\.drawDurations\.length > 120/);
  assert.match(atlas, /this\.animationFrameInterval = 50/);
  assert.match(app, /__CURRICULUM_ATLAS_DIAGNOSTICS__/);
  assert.match(app, /PerformanceObserver\.supportedEntryTypes\?\.includes\('longtask'\)/);
  assert.match(app, /diagnosticsReadyAt - diagnosticsStartedAt/);
  assert.match(app, /entry\.startTime >= diagnosticsStartedAt/);
  assert.doesNotMatch(app, /performance-dashboard|second-canvas/);
});
