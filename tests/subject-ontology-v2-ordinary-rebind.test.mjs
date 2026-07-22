import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  parseArgs,
  rebindOrdinarySubjectOntologyV2,
} from '../scripts/rebind-subject-ontology-v2-ordinary.mjs';
import { validateSubjectOntologyV2 } from '../scripts/validate-subject-ontology-v2.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const INDEX_PATH = 'data/ontologies/index.json';
const REPORT_PATH = 'data/subject-ontology-v2-validation.json';
const TRANSACTION_PATH = 'data/.subject-ontology-v2-ordinary-rebind-transaction.json';
const FIXTURE_FILES = [
  INDEX_PATH,
  REPORT_PATH,
  'data/catalog.json',
  'data/concept-model-v2.json',
  'data/corpus-chunks/manifest.json',
  'data/document-sources.json',
  'data/online-verification-standard.json',
  'data/page-publication-manifest.json',
  'data/schemas/subject-ontology-v2.schema.json',
  'data/semantic-publication-policy.json',
  'scripts/page-evidence/fail-closed-manifest.json',
  'scripts/page-evidence/online-source-identities.json',
  'scripts/page-evidence/reviewer-authorities.json',
];

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const sameBytesForTest = (left, right) => left.length === right.length && left.equals(right);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('formal verify rebinds and validates the ordinary ontology immediately after every corpus build', async () => {
  const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const steps = packageJson.scripts.verify.split(' && ');
  const corpusBuild = steps.indexOf('npm run corpus:build');
  assert.notEqual(corpusBuild, -1);
  assert.equal(steps[corpusBuild + 1], 'npm run ontology:v2:ordinary:rebind');
  assert.equal(steps[corpusBuild + 2], 'npm run ontology:v2:validate');
  assert.equal(steps.filter((step) => step === 'npm run ontology:v2:ordinary:rebind').length, 1);
  assert.equal(steps.filter((step) => step === 'npm run ontology:v2:validate').length, 1);
  assert.equal(steps.indexOf('npm run concepts:build') > corpusBuild + 2, true);
});

async function copyFixture() {
  const root = await mkdtemp(join(tmpdir(), 'curriculum-ordinary-ontology-rebind-'));
  for (const relativePath of FIXTURE_FILES) {
    const destination = join(root, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(projectRoot, relativePath), destination);
  }
  return root;
}

async function readJson(root, relativePath) {
  return JSON.parse(await readFile(join(root, relativePath), 'utf8'));
}

async function writeJson(root, relativePath, value) {
  await writeFile(join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

async function identities(root, paths = FIXTURE_FILES) {
  return Object.fromEntries(await Promise.all(paths.map(async (relativePath) => {
    const bytes = await readFile(join(root, relativePath));
    return [relativePath, { sha256: sha256(bytes), bytes: bytes.length }];
  })));
}

test('ordinary rebind is byte-idempotent, exact, and changes only index/report', async () => {
  const root = await copyFixture();
  try {
    const originalIndex = await readFile(join(root, INDEX_PATH), 'utf8');
    const currentCatalogSha = (await readJson(root, INDEX_PATH)).bindings.catalog.sha256;
    const staleIndex = originalIndex.replace(currentCatalogSha, '0'.repeat(64));
    assert.notEqual(staleIndex, originalIndex);
    await writeFile(join(root, INDEX_PATH), staleIndex);
    const preservedSuffix = staleIndex.slice(staleIndex.indexOf('  "canonical_facets"'));
    const protectedPaths = FIXTURE_FILES.filter((path) => ![INDEX_PATH, REPORT_PATH].includes(path));
    const protectedBefore = await identities(root, protectedPaths);

    const first = await rebindOrdinarySubjectOntologyV2({ root });
    assert.equal(first.changed, true);
    assert.equal(first.catalog.documents, 195);
    assert.equal(first.corpus.documents, 195);
    assert.equal(first.corpus.sql_chunks, 93);
    const firstIndex = await readFile(join(root, INDEX_PATH));
    const firstReport = await readFile(join(root, REPORT_PATH));
    assert.equal(firstIndex.toString('utf8').slice(firstIndex.toString('utf8').indexOf('  "canonical_facets"')), preservedSuffix);
    assert.equal(validateSubjectOntologyV2({ rootDir: root }).publishable, false);
    assert.deepEqual(await identities(root, protectedPaths), protectedBefore);

    const second = await rebindOrdinarySubjectOntologyV2({ root });
    assert.equal(second.changed, false);
    assert.deepEqual(await readFile(join(root, INDEX_PATH)), firstIndex);
    assert.deepEqual(await readFile(join(root, REPORT_PATH)), firstReport);
    assert.deepEqual(await identities(root, protectedPaths), protectedBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('startup recovers a durable prepared transaction after SIGKILL between governed output writes', async () => {
  const root = await copyFixture();
  let child;
  try {
    const currentIndex = await readJson(root, INDEX_PATH);
    const staleIndexText = (await readFile(join(root, INDEX_PATH), 'utf8'))
      .replace(currentIndex.bindings.catalog.sha256, '0'.repeat(64));
    await writeFile(join(root, INDEX_PATH), staleIndexText);
    const staleReport = await readJson(root, REPORT_PATH);
    staleReport.index.sha256 = '0'.repeat(64);
    await writeJson(root, REPORT_PATH, staleReport);
    const staleIndexBuffer = await readFile(join(root, INDEX_PATH));
    const staleReportBuffer = await readFile(join(root, REPORT_PATH));
    const moduleUrl = pathToFileURL(join(projectRoot, 'scripts/rebind-subject-ontology-v2-ordinary.mjs')).href;
    const childSource = [
      `import { rebindOrdinarySubjectOntologyV2 } from ${JSON.stringify(moduleUrl)};`,
      'await rebindOrdinarySubjectOntologyV2({',
      '  root: process.env.REBIND_FIXTURE_ROOT,',
      '  testHooks: {',
      '    afterJournalTemporarySync: async () => {},',
      '    afterIndexTemporarySync: async () => {},',
      '    afterIndexWrite: async () => new Promise((resolve) => setTimeout(resolve, 60_000)),',
      '  },',
      '});',
    ].join('\n');
    child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        REBIND_FIXTURE_ROOT: root,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`rebind child exited before interruption point: ${stderr}`);
      }
      if (!(await exists(join(root, TRANSACTION_PATH)))) return false;
      const indexNow = await readFile(join(root, INDEX_PATH));
      const reportNow = await readFile(join(root, REPORT_PATH));
      return !sameBytesForTest(indexNow, staleIndexBuffer) && sameBytesForTest(reportNow, staleReportBuffer);
    }, 'prepared journal and first governed rename');
    const interruptedBefore = await identities(root, [INDEX_PATH, REPORT_PATH, TRANSACTION_PATH]);
    await assert.rejects(
      rebindOrdinarySubjectOntologyV2({ root }),
      /transaction.*still owned by a live process/i,
    );
    assert.deepEqual(await identities(root, [INDEX_PATH, REPORT_PATH, TRANSACTION_PATH]), interruptedBefore);
    const childExit = once(child, 'exit');
    assert.equal(child.kill('SIGKILL'), true);
    const [exitCode, signal] = await childExit;
    assert.equal(exitCode, null);
    assert.equal(signal, 'SIGKILL');
    child = null;
    assert.equal(await exists(join(root, TRANSACTION_PATH)), true);

    const recovered = await rebindOrdinarySubjectOntologyV2({ root });
    assert.equal(recovered.recovered_transaction, 'rolled_back_prepared_transaction');
    assert.equal(recovered.changed, true);
    assert.equal(validateSubjectOntologyV2({ rootDir: root }).publishable, false);
    assert.equal(await exists(join(root, TRANSACTION_PATH)), false);
    const leftovers = (await readdir(join(root, 'data')))
      .filter((name) => name.startsWith('.subject-ontology-v2-ordinary-rebind'));
    assert.deepEqual(leftovers, []);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit').catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('startup removes only its transaction temp after SIGKILL between index fsync and rename', async () => {
  const root = await copyFixture();
  let child;
  try {
    const currentIndex = await readJson(root, INDEX_PATH);
    const staleIndexText = (await readFile(join(root, INDEX_PATH), 'utf8'))
      .replace(currentIndex.bindings.catalog.sha256, '0'.repeat(64));
    await writeFile(join(root, INDEX_PATH), staleIndexText);
    const staleReport = await readJson(root, REPORT_PATH);
    staleReport.index.sha256 = '0'.repeat(64);
    await writeJson(root, REPORT_PATH, staleReport);
    const staleIndexBuffer = await readFile(join(root, INDEX_PATH));
    const staleReportBuffer = await readFile(join(root, REPORT_PATH));
    const unrelatedPath = join(root, 'data/.ordinary-rebind-unrelated.txt');
    await writeFile(unrelatedPath, 'preserve me\n');
    const moduleUrl = pathToFileURL(join(projectRoot, 'scripts/rebind-subject-ontology-v2-ordinary.mjs')).href;
    const childSource = [
      `import { rebindOrdinarySubjectOntologyV2 } from ${JSON.stringify(moduleUrl)};`,
      'await rebindOrdinarySubjectOntologyV2({',
      '  root: process.env.REBIND_FIXTURE_ROOT,',
      '  testHooks: {',
      '    afterJournalTemporarySync: async () => {},',
      '    afterIndexTemporarySync: async () => new Promise((resolve) => setTimeout(resolve, 60_000)),',
      '    afterIndexWrite: async () => {},',
      '  },',
      '});',
    ].join('\n');
    child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        REBIND_FIXTURE_ROOT: root,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    let indexTemporaryPath;
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`rebind child exited before temp-fsync interruption point: ${stderr}`);
      }
      if (!(await exists(join(root, TRANSACTION_PATH)))) return false;
      const journal = await readJson(root, TRANSACTION_PATH);
      indexTemporaryPath = join(root, journal.outputs.index.temporary_path);
      if (!(await exists(indexTemporaryPath))) return false;
      return sameBytesForTest(await readFile(join(root, INDEX_PATH)), staleIndexBuffer)
        && sameBytesForTest(await readFile(join(root, REPORT_PATH)), staleReportBuffer);
    }, 'fsynced index temp before rename');
    const childExit = once(child, 'exit');
    assert.equal(child.kill('SIGKILL'), true);
    const [exitCode, signal] = await childExit;
    assert.equal(exitCode, null);
    assert.equal(signal, 'SIGKILL');
    child = null;
    assert.equal(await exists(indexTemporaryPath), true);

    const recovered = await rebindOrdinarySubjectOntologyV2({ root });
    assert.equal(recovered.recovered_transaction, 'rolled_back_prepared_transaction');
    assert.equal(recovered.changed, true);
    assert.equal(validateSubjectOntologyV2({ rootDir: root }).publishable, false);
    assert.equal(await exists(indexTemporaryPath), false);
    assert.equal(await readFile(unrelatedPath, 'utf8'), 'preserve me\n');
    const dataTemps = (await readdir(join(root, 'data')))
      .filter((name) => name.startsWith('.subject-ontology-v2-ordinary-rebind'));
    const ontologyTemps = (await readdir(join(root, 'data/ontologies')))
      .filter((name) => name.includes('.ordinary-rebind-'));
    assert.deepEqual(dataTemps, []);
    assert.deepEqual(ontologyTemps, []);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit').catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('startup removes a dead owner journal temp after SIGKILL between fsync and no-replace link', async () => {
  const root = await copyFixture();
  let child;
  try {
    const currentIndex = await readJson(root, INDEX_PATH);
    const staleIndexText = (await readFile(join(root, INDEX_PATH), 'utf8'))
      .replace(currentIndex.bindings.catalog.sha256, '0'.repeat(64));
    await writeFile(join(root, INDEX_PATH), staleIndexText);
    const staleReport = await readJson(root, REPORT_PATH);
    staleReport.index.sha256 = '0'.repeat(64);
    await writeJson(root, REPORT_PATH, staleReport);
    const staleIndexBuffer = await readFile(join(root, INDEX_PATH));
    const staleReportBuffer = await readFile(join(root, REPORT_PATH));
    const unrelatedPath = join(root, 'data/.ordinary-rebind-journal-unrelated.txt');
    await writeFile(unrelatedPath, 'preserve journal decoy\n');
    const moduleUrl = pathToFileURL(join(projectRoot, 'scripts/rebind-subject-ontology-v2-ordinary.mjs')).href;
    const childSource = [
      `import { rebindOrdinarySubjectOntologyV2 } from ${JSON.stringify(moduleUrl)};`,
      'await rebindOrdinarySubjectOntologyV2({',
      '  root: process.env.REBIND_FIXTURE_ROOT,',
      '  testHooks: {',
      '    afterJournalTemporarySync: async () => new Promise((resolve) => setTimeout(resolve, 60_000)),',
      '    afterIndexTemporarySync: async () => {},',
      '    afterIndexWrite: async () => {},',
      '  },',
      '});',
    ].join('\n');
    child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        REBIND_FIXTURE_ROOT: root,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    let journalTemporaryPath;
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`rebind child exited before journal-fsync interruption point: ${stderr}`);
      }
      const matches = (await readdir(join(root, 'data'))).filter((name) => (
        /^\.subject-ontology-v2-ordinary-rebind-journal-\d+-[a-f0-9-]{36}\.tmp$/u.test(name)
      ));
      if (matches.length !== 1 || await exists(join(root, TRANSACTION_PATH))) return false;
      journalTemporaryPath = join(root, 'data', matches[0]);
      return sameBytesForTest(await readFile(join(root, INDEX_PATH)), staleIndexBuffer)
        && sameBytesForTest(await readFile(join(root, REPORT_PATH)), staleReportBuffer);
    }, 'fsynced journal temp before no-replace link');
    const childExit = once(child, 'exit');
    assert.equal(child.kill('SIGKILL'), true);
    const [exitCode, signal] = await childExit;
    assert.equal(exitCode, null);
    assert.equal(signal, 'SIGKILL');
    child = null;
    assert.equal(await exists(journalTemporaryPath), true);
    assert.equal(await exists(join(root, TRANSACTION_PATH)), false);

    const recovered = await rebindOrdinarySubjectOntologyV2({ root });
    assert.equal(recovered.recovered_transaction, null);
    assert.equal(recovered.changed, true);
    assert.equal(validateSubjectOntologyV2({ rootDir: root }).publishable, false);
    assert.equal(await exists(journalTemporaryPath), false);
    assert.equal(await readFile(unrelatedPath, 'utf8'), 'preserve journal decoy\n');
    const dataTemps = (await readdir(join(root, 'data')))
      .filter((name) => name.startsWith('.subject-ontology-v2-ordinary-rebind'));
    assert.deepEqual(dataTemps, []);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit').catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary rebind rejects gate tamper and leaves both governed outputs unchanged', async () => {
  const root = await copyFixture();
  try {
    const index = await readJson(root, INDEX_PATH);
    index.release_gate.builder_input_allowed = true;
    await writeJson(root, INDEX_PATH, index);
    const before = await identities(root, [INDEX_PATH, REPORT_PATH]);
    await assert.rejects(
      rebindOrdinarySubjectOntologyV2({ root }),
      /ordinary fail-closed.*builder_input_allowed/i,
    );
    assert.deepEqual(await identities(root, [INDEX_PATH, REPORT_PATH]), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary rebind rejects registered, unregistered, and universe ontology content', async (t) => {
  await t.test('registered scope', async () => {
    const root = await copyFixture();
    try {
      const index = await readJson(root, INDEX_PATH);
      index.canonical_facets[0].scope_files = ['data/ontologies/chinese-language/rogue.json'];
      await writeJson(root, INDEX_PATH, index);
      await assert.rejects(rebindOrdinarySubjectOntologyV2({ root }), /scope_files must remain empty/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test('unregistered scope artifact', async () => {
    const root = await copyFixture();
    try {
      const rogue = join(root, 'data/ontologies/chinese-language/rogue.json');
      await mkdir(dirname(rogue), { recursive: true });
      await writeFile(rogue, '{}\n');
      await assert.rejects(rebindOrdinarySubjectOntologyV2({ root }), /unregistered ontology artifact/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test('coverage universe', async () => {
    const root = await copyFixture();
    try {
      const index = await readJson(root, INDEX_PATH);
      index.coverage_universes = [{ universe_id: 'forbidden' }];
      await writeJson(root, INDEX_PATH, index);
      await assert.rejects(rebindOrdinarySubjectOntologyV2({ root }), /coverage_universes must remain empty/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test('ordinary rebind rejects non-zero or publishable page evidence and every promotion flag', async () => {
  const root = await copyFixture();
  try {
    const governedBefore = await identities(root, [INDEX_PATH, REPORT_PATH]);
    await assert.rejects(
      rebindOrdinarySubjectOntologyV2({ root, promotion: true }),
      /promotion.*forbidden/i,
    );
    assert.throws(() => parseArgs(['--promotion']), /promotion.*forbidden/i);
    assert.deepEqual(await identities(root, [INDEX_PATH, REPORT_PATH]), governedBefore);

    const release = await readJson(root, 'scripts/page-evidence/fail-closed-manifest.json');
    release.status = 'publication_candidate';
    await writeJson(root, 'scripts/page-evidence/fail-closed-manifest.json', release);
    await assert.rejects(
      rebindOrdinarySubjectOntologyV2({ root }),
      /page evidence|publication_candidate|promotion/i,
    );
    assert.deepEqual(await identities(root, [INDEX_PATH, REPORT_PATH]), governedBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
