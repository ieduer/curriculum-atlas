import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function source(locator) {
  return readFile(new URL(locator, root), 'utf8');
}

test('formal verify has an explicit ordinary page-evidence gate and dedicated promotion commands', async () => {
  const packageJson = JSON.parse(await source('package.json'));
  assert.match(packageJson.scripts.verify, /page-evidence:validate/);
  for (const name of ['metadata:publish:preview', 'metadata:publish:production', 'deploy:preview', 'deploy:production']) {
    assert.doesNotMatch(packageJson.scripts[name], /--page-evidence-promotion/, `${name} must remain ordinary`);
  }
  assert.match(packageJson.scripts['deploy:page-evidence:preview'], /--page-evidence-promotion/);
  assert.match(packageJson.scripts['deploy:page-evidence:production'], /--page-evidence-promotion/);
});

test('real page-evidence CLI accepts ordinary mode and fails closed for unavailable promotion', () => {
  const ordinary = spawnSync(process.execPath, ['scripts/page-evidence-release-hook.mjs', '--mode', 'ordinary'], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(ordinary.status, 0, ordinary.stderr);
  const ordinaryResult = JSON.parse(ordinary.stdout);
  assert.equal(ordinaryResult.valid, true);
  assert.equal(ordinaryResult.publishable, false);

  const promotion = spawnSync(process.execPath, ['scripts/page-evidence-release-hook.mjs', '--mode', 'promotion'], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(promotion.status, 1);
  assert.match(promotion.stderr, /promotion requires a valid publication_candidate/);
});

test('shared hook rejects publishable evidence in ordinary mode and nonpublishable evidence in promotion mode', async () => {
  const {
    assertPageEvidenceReleaseMode,
    validatePageEvidenceForRelease,
  } = await import('../scripts/page-evidence-release-hook.mjs');
  assert.throws(
    () => assertPageEvidenceReleaseMode({ valid: true, publishable: true }, { pageEvidencePromotion: false }),
    /dedicated page-evidence promotion/,
  );
  assert.throws(
    () => assertPageEvidenceReleaseMode({ valid: true, publishable: false }, { pageEvidencePromotion: true }),
    /requires publishable page evidence/,
  );
  assert.equal(
    assertPageEvidenceReleaseMode(
      { valid: true, publishable: false },
      { pageEvidencePromotion: false },
    ).publishable,
    false,
  );

  let validatorOptions = null;
  const promoted = validatePageEvidenceForRelease({
    pageEvidencePromotion: true,
    validator(options) {
      validatorOptions = options;
      return { valid: true, publishable: true };
    },
  });
  assert.equal(validatorOptions.requirePublishable, true);
  assert.equal(promoted.publishable, true);
});
