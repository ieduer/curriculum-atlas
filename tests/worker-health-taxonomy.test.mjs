import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);

async function loadWorker() {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('src/index.ts', root))],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  });
  const encoded = Buffer.from(bundle.outputFiles[0].text).toString('base64');
  return (await import(`data:text/javascript;base64,${encoded}`)).default;
}

function makeEnv(classification) {
  return {
    DB: {
      prepare(sql) {
        if (sql.includes('FROM site_meta')) {
          return {
            async all() {
              return {
                results: [
                  { key: 'schema_version', value: '3' },
                  { key: 'document_classification_schema_version', value: '1' },
                ],
              };
            },
          };
        }
        return { async first() { return classification; } };
      },
    },
    SOURCES: {},
    APIS: {},
    USER_CENTER: {},
    ASSETS: {},
    ENVIRONMENT: 'test',
  };
}

test('Worker health fails closed unless the complete taxonomy distribution matches production', async () => {
  const source = await readFile(new URL('src/index.ts', root), 'utf8');

  assert.match(source, /REQUIRED_CLASSIFICATION_COUNTS\s*=\s*\{[\s\S]*?documents:\s*196,[\s\S]*?subjects:\s*160,[\s\S]*?courses:\s*16,[\s\S]*?scopes:\s*20,[\s\S]*?unclassified:\s*0,/);
  assert.match(source, /classificationCounts\.documents === REQUIRED_CLASSIFICATION_COUNTS\.documents/);
  assert.match(source, /classificationCounts\.classified === REQUIRED_CLASSIFICATION_COUNTS\.documents/);
  assert.match(source, /classificationCounts\.subjects === REQUIRED_CLASSIFICATION_COUNTS\.subjects/);
  assert.match(source, /classificationCounts\.courses === REQUIRED_CLASSIFICATION_COUNTS\.courses/);
  assert.match(source, /classificationCounts\.scopes === REQUIRED_CLASSIFICATION_COUNTS\.scopes/);
  assert.match(source, /classificationCounts\.unclassified === REQUIRED_CLASSIFICATION_COUNTS\.unclassified/);
  assert.match(source, /schemaReady && classificationReady \? 200 : 503/);
  assert.doesNotMatch(source, /classificationCounts\.documents === classificationCounts\.classified/);
});

test('Worker health accepts 196/160/16/20/0 and rejects the legacy 196/175/0/20/0 distribution', async () => {
  const worker = await loadWorker();
  const request = new Request('https://curriculum.example/api/health');

  const valid = await worker.fetch(request, makeEnv({
    documents: 196,
    classified: 196,
    subject_documents: 160,
    course_documents: 16,
    scope_documents: 20,
    unclassified_documents: 0,
  }));
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).ok, true);

  const legacy = await worker.fetch(request, makeEnv({
    documents: 196,
    classified: 196,
    subject_documents: 175,
    course_documents: 0,
    scope_documents: 20,
    unclassified_documents: 0,
  }));
  const legacyBody = await legacy.json();
  assert.equal(legacy.status, 503);
  assert.equal(legacyBody.ok, false);
  assert.equal(legacyBody.classification.complete, false);
});
