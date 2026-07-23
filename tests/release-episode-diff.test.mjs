import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const receipt = await readFile(new URL('data/release-episode-diff.json', root), 'utf8').then(JSON.parse);

test('the release diff is anchored to the frozen production baseline', () => {
  assert.equal(receipt.artifact_profile, 'curriculum-release-episode-diff-v1');
  assert.equal(receipt.baseline.tag, 'curriculum-baseline-20260723-7cedbe95');
  assert.match(receipt.baseline.commit, /^[0-9a-f]{40}$/);
  assert.equal(receipt.baseline.production_worker_version_id, '7cedbe95-fed7-432b-85ef-d89a3baf2d6f');
});

test('stable episode identity cannot be silently removed or moved between layers', () => {
  assert.equal(receipt.release_gate.stable_ids_preserved, true);
  assert.equal(receipt.release_gate.removed_episode_count_allowed, 0);
  assert.equal(receipt.release_gate.cross_layer_move_count_allowed, 0);
  assert.equal(receipt.release_gate.deployment_allowed, true);
  assert.equal(receipt.counts.removed, 0);
  assert.equal(receipt.counts.cross_layer_moves, 0);
  assert.equal(receipt.counts.current,
    receipt.counts.unchanged + receipt.counts.updated + receipt.counts.added);
});
