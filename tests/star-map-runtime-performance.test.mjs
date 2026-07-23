import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRuntimePerformance } from '../scripts/validate-star-map-runtime-performance.mjs';

const budget = {
  budget_id: 'runtime-test-v1',
  runtime: {
    desktop: {
      viewport: [1440, 1000],
      ready_ms_max: 6500,
      resource_transfer_bytes_max: 8000000,
      draw_p95_ms_max: 50,
      long_task_count_max: 12,
      long_task_total_ms_max: 1800,
    },
    mobile: {
      viewport: [390, 844],
      ready_ms_max: 8000,
      resource_transfer_bytes_max: 8000000,
      draw_p95_ms_max: 60,
      long_task_count_max: 14,
      long_task_total_ms_max: 2200,
    },
  },
};

function measurement() {
  return {
    environment: 'preview',
    target_url: 'https://preview.example.com/',
    budget_id: budget.budget_id,
    measured_at: '2026-07-23T00:00:00.000Z',
    measurements: {
      desktop: {
        viewport: [1440, 1000],
        ready_ms: 1000,
        resource_transfer_bytes: 1000000,
        draw_p95_ms: 10,
        long_task_count: 1,
        long_task_total_ms: 50,
      },
      mobile: {
        viewport: [390, 844],
        ready_ms: 1200,
        resource_transfer_bytes: 1000000,
        draw_p95_ms: 12,
        long_task_count: 1,
        long_task_total_ms: 50,
      },
    },
  };
}

test('preview runtime receipt passes only when every viewport stays inside budget', () => {
  const receipt = validateRuntimePerformance({
    measurement: measurement(),
    budget,
    sourceFingerprints: { 'public/app.js': 'abc' },
  });
  assert.equal(receipt.release_decision, 'pass');
  assert.equal(receipt.deployment_allowed, true);
  assert.ok(receipt.checks.every((item) => item.passed));
});

test('one runtime budget breach blocks production without an override path', () => {
  const failing = measurement();
  failing.measurements.mobile.draw_p95_ms = 61;
  const receipt = validateRuntimePerformance({
    measurement: failing,
    budget,
    sourceFingerprints: { 'public/app.js': 'abc' },
  });
  assert.equal(receipt.release_decision, 'block');
  assert.equal(receipt.deployment_allowed, false);
  assert.equal(receipt.checks.find((item) => item.id === 'runtime.mobile.draw_p95_ms').passed, false);
});
