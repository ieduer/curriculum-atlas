import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function source(locator) {
  return readFile(new URL(locator, root), 'utf8');
}

test('formal verify has an explicit ordinary page-evidence gate and dedicated promotion commands', async () => {
  const packageJson = JSON.parse(await source('package.json'));
  assert.match(packageJson.scripts.verify, /page-evidence:validate/);
  assert.match(packageJson.scripts['deploy:page-evidence:preview'], /--page-evidence-promotion/);
  assert.match(packageJson.scripts['deploy:page-evidence:production'], /--page-evidence-promotion/);
});

test('direct corpus build cannot bypass ordinary or promotion page-evidence mode', async () => {
  const value = await source('scripts/build-corpus.mjs');
  assert.match(value, /validatePageEvidenceForRelease/);
  assert.match(value, /--page-evidence-promotion/);
});

test('direct corpus import validates page evidence before any remote D1 command', async () => {
  const value = await source('scripts/import-corpus.mjs');
  const main = value.slice(value.indexOf('async function main()'));
  const gate = main.indexOf('validatePageEvidenceForRelease(');
  const firstRemote = main.indexOf("runWrangler(root, database");
  assert.ok(gate >= 0 && firstRemote > gate, 'page-evidence import gate must precede remote D1 execution');
});

test('direct release-manifest and Worker deploy entrypoints carry the same explicit mode', async () => {
  for (const locator of ['scripts/build-release-manifest.mjs', 'scripts/deploy-worker.mjs']) {
    const value = await source(locator);
    assert.match(value, /validatePageEvidenceForRelease/);
    assert.match(value, /pageEvidencePromotion/);
  }
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
