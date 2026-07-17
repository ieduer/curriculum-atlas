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

const readyCoreCounts = {
  subjects: 0,
  periods: 5,
  document_relations: 0,
  chapters: 0,
  document_classifications: 196,
  document_sources: 252,
  primary_document_sources: 196,
  subject_insights: 6,
  terms: 5,
  term_relations: 4,
  version_diffs: 0,
  online_verifications: 1,
  online_evidence: 5,
};

function readyCorpus(overrides = {}) {
  return {
    release_id: 'corpus-test-ready',
    manifest_sha256: 'a'.repeat(64),
    state: 'ready',
    expected_documents: 196,
    expected_paragraphs: 1,
    expected_fts_rows: 1,
    expected_page_gates: 1,
    expected_displayed_paragraphs: 1,
    accepted_ocr_documents: 0,
    expected_chunks: 1,
    expected_core_counts_json: JSON.stringify(readyCoreCounts),
    actual_documents: 196,
    actual_paragraphs: 1,
    actual_fts_rows: 1,
    actual_page_gates: 1,
    actual_displayed_paragraphs: 1,
    actual_chunks: 1,
    actual_core_counts_json: JSON.stringify(readyCoreCounts),
    live_documents: 196,
    live_paragraphs: 1,
    live_fts_rows: 1,
    live_page_gates: 1,
    live_displayed_paragraphs: 1,
    live_accepted_ocr_documents: 0,
    live_chunks: 1,
    live_core_counts_json: JSON.stringify(readyCoreCounts),
    ...overrides,
  };
}

function makeEnv(classification, corpus = readyCorpus()) {
  const classificationWithTaxonomy = {
    academic_identity_documents: 160,
    assessment_subject_documents: 1,
    display_facets: 12,
    ...classification,
  };
  return {
    DB: {
      prepare(sql) {
        if (sql.includes('FROM corpus_import_releases r')) {
          return { async first() { return corpus; } };
        }
        if (sql.includes('FROM site_meta')) {
          return {
            async all() {
              return {
                results: [
                  { key: 'schema_version', value: '3' },
                  { key: 'document_classification_schema_version', value: '2' },
                  { key: 'page_publication_schema_version', value: '1' },
                ],
              };
            },
          };
        }
        return {
          bind() { return this; },
          async first() { return classificationWithTaxonomy; },
        };
      },
    },
    SOURCES: {},
    APIS: {},
    USER_CENTER: {},
    ASSETS: {},
    ENVIRONMENT: 'test',
    RELEASE_GIT_COMMIT: 'a'.repeat(40),
  };
}

const displayFacetNames = [
  '语文', '数学', '外语', '思想政治与道德法治', '历史', '历史与社会',
  '地理', '科学类', '技术', '劳动', '艺术', '体育与健康',
];

function makeTaxonomyApiEnv() {
  return {
    ...makeEnv({
      documents: 196,
      classified: 196,
      subject_documents: 159,
      course_documents: 16,
      scope_documents: 20,
      unclassified_documents: 0,
    }),
    DB: {
      prepare(sql) {
        let bindings = [];
        const statement = {
          bind(...values) { bindings = values; return statement; },
          async first() {
            if (sql.includes('FROM corpus_import_releases r')) return readyCorpus();
            if (sql.includes('SELECT dc.canonical_subject FROM document_classifications')) {
              return bindings[0] === '汉语' ? null : { canonical_subject: bindings[0] };
            }
            if (sql.includes('SELECT d.*, dc.entity_kind')) {
              return bindings[0] === 'neea-2019-05' ? {
                id: 'neea-2019-05',
                title: '2019年普通高等学校招生全国统一考试大纲：汉语',
                subject: '汉语',
                entity_kind: 'subject',
                taxonomy_entity_kind: 'assessment_subject',
                canonical_subject: '汉语',
                display_facet: '语文',
                source_subject_label: '汉语',
                entity_label: '汉语',
              } : null;
            }
            return { count: sql.includes("citation_allowed=1") ? 101 : sql.includes('paragraphs') ? 16456 : 196 };
          },
          async all() {
            if (sql.includes('SELECT dc.display_facet AS name')) {
              return { results: displayFacetNames.map((name) => ({ name, documentCount: 1, firstYear: 1902, lastYear: 2022 })) };
            }
            if (sql.includes("dc.taxonomy_entity_kind = 'assessment_subject'")) {
              return { results: [{ name: '汉语', taxonomyEntityKind: 'assessment_subject', relatedDisplayFacet: '语文', documentCount: 1, firstYear: 2019, lastYear: 2019 }] };
            }
            if (sql.includes('SELECT dc.canonical_subject AS name')) {
              return { results: [{ name: '语文', taxonomyEntityKind: 'subject', displayFacet: '语文', documentCount: 10, firstYear: 1902, lastYear: 2022 }] };
            }
            if (sql.includes('SELECT dc.scope_label AS name')) return { results: [] };
            if (sql.includes('SELECT * FROM periods')) return { results: [] };
            return { results: [] };
          },
        };
        return statement;
      },
    },
    TURNSTILE_SITE_KEY: 'test-site-key',
  };
}

test('Worker health fails closed unless the complete taxonomy distribution matches production', async () => {
  const source = await readFile(new URL('src/index.ts', root), 'utf8');

  assert.match(source, /REQUIRED_CLASSIFICATION_COUNTS\s*=\s*\{[\s\S]*?documents:\s*196,[\s\S]*?academicIdentities:\s*160,[\s\S]*?subjects:\s*159,[\s\S]*?assessmentSubjects:\s*1,[\s\S]*?displayFacets:\s*12,[\s\S]*?courses:\s*16,[\s\S]*?scopes:\s*20,[\s\S]*?unclassified:\s*0,/);
  assert.match(source, /classificationCounts\.documents === REQUIRED_CLASSIFICATION_COUNTS\.documents/);
  assert.match(source, /classificationCounts\.classified === REQUIRED_CLASSIFICATION_COUNTS\.documents/);
  assert.match(source, /classificationCounts\.academicIdentities === REQUIRED_CLASSIFICATION_COUNTS\.academicIdentities/);
  assert.match(source, /classificationCounts\.subjects === REQUIRED_CLASSIFICATION_COUNTS\.subjects/);
  assert.match(source, /classificationCounts\.assessmentSubjects === REQUIRED_CLASSIFICATION_COUNTS\.assessmentSubjects/);
  assert.match(source, /classificationCounts\.displayFacets === REQUIRED_CLASSIFICATION_COUNTS\.displayFacets/);
  assert.match(source, /classificationCounts\.courses === REQUIRED_CLASSIFICATION_COUNTS\.courses/);
  assert.match(source, /classificationCounts\.scopes === REQUIRED_CLASSIFICATION_COUNTS\.scopes/);
  assert.match(source, /classificationCounts\.unclassified === REQUIRED_CLASSIFICATION_COUNTS\.unclassified/);
  assert.match(source, /schemaMeta\.get\('page_publication_schema_version'\) === '1'/);
  assert.match(source, /schemaReady && classificationReady && corpusReady && releaseSourceReady \? 200 : 503/);
  assert.match(source, /corpusReleaseReady\(corpus\)/);
  assert.match(source, /coreTableCountsEqual\(expectedCore, actualCore\)/);
  assert.match(source, /coreTableCountsEqual\(expectedCore, liveCore\)/);
  assert.doesNotMatch(source, /classificationCounts\.documents === classificationCounts\.classified/);
});

test('Worker health accepts 159 subjects plus one assessment identity and rejects the legacy 196/175/0/20/0 distribution', async () => {
  const worker = await loadWorker();
  const request = new Request('https://curriculum.example/api/health');

  const valid = await worker.fetch(request, makeEnv({
    documents: 196,
    classified: 196,
    subject_documents: 159,
    course_documents: 16,
    scope_documents: 20,
    unclassified_documents: 0,
  }));
  assert.equal(valid.status, 200);
  const validBody = await valid.json();
  assert.equal(validBody.ok, true);
  assert.equal(validBody.classification.academicIdentityDocuments, 160);
  assert.equal(validBody.classification.assessmentSubjectDocuments, 1);
  assert.equal(validBody.classification.displayFacets, 12);
  assert.equal(validBody.pagePublicationSchemaVersion, '1');
  assert.deepEqual(validBody.corpus.expected.coreTables, readyCoreCounts);
  assert.deepEqual(validBody.corpus.actual.coreTables, readyCoreCounts);
  assert.deepEqual(validBody.corpus.live.coreTables, readyCoreCounts);

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

  const importing = await worker.fetch(request, makeEnv({
    documents: 196,
    classified: 196,
    subject_documents: 159,
    course_documents: 16,
    scope_documents: 20,
    unclassified_documents: 0,
  }, readyCorpus({ state: 'in_progress' })));
  assert.equal(importing.status, 503);
  assert.equal((await importing.json()).corpus.ready, false);

  const coreDrift = await worker.fetch(request, makeEnv({
    documents: 196,
    classified: 196,
    subject_documents: 159,
    course_documents: 16,
    scope_documents: 20,
    unclassified_documents: 0,
  }, readyCorpus({
    live_core_counts_json: JSON.stringify({ ...readyCoreCounts, document_sources: 253 }),
  })));
  const coreDriftBody = await coreDrift.json();
  assert.equal(coreDrift.status, 503);
  assert.equal(coreDriftBody.corpus.ready, false);
  assert.equal(coreDriftBody.corpus.live.coreTables.document_sources, 253);

  const extraCoreKey = await worker.fetch(request, makeEnv({
    documents: 196,
    classified: 196,
    subject_documents: 159,
    course_documents: 16,
    scope_documents: 20,
    unclassified_documents: 0,
  }, readyCorpus({
    live_core_counts_json: JSON.stringify({ ...readyCoreCounts, comments: 0 }),
  })));
  const extraCoreKeyBody = await extraCoreKey.json();
  assert.equal(extraCoreKey.status, 503);
  assert.equal(extraCoreKeyBody.corpus.ready, false);
  assert.equal(extraCoreKeyBody.corpus.live.coreTables, null);

  const legacyCoreRow = await worker.fetch(request, makeEnv({
    documents: 196,
    classified: 196,
    subject_documents: 159,
    course_documents: 16,
    scope_documents: 20,
    unclassified_documents: 0,
  }, readyCorpus({
    live_core_counts_json: JSON.stringify({ ...readyCoreCounts, chapters: 1 }),
  })));
  const legacyCoreRowBody = await legacyCoreRow.json();
  assert.equal(legacyCoreRow.status, 503);
  assert.equal(legacyCoreRowBody.corpus.ready, false);
  assert.equal(legacyCoreRowBody.corpus.live.coreTables, null);
});

test('Worker health fails closed when any taxonomy metric drifts independently', async () => {
  const worker = await loadWorker();
  const request = new Request('https://curriculum.example/api/health');
  const baseline = {
    documents: 196,
    classified: 196,
    academic_identity_documents: 160,
    subject_documents: 159,
    assessment_subject_documents: 1,
    display_facets: 12,
    course_documents: 16,
    scope_documents: 20,
    unclassified_documents: 0,
  };
  const drifts = {
    documents: 195,
    classified: 195,
    academic_identity_documents: 159,
    subject_documents: 158,
    assessment_subject_documents: 0,
    display_facets: 11,
    course_documents: 15,
    scope_documents: 19,
    unclassified_documents: 1,
  };

  for (const [metric, drifted] of Object.entries(drifts)) {
    const response = await worker.fetch(request, makeEnv({ ...baseline, [metric]: drifted }));
    assert.equal(response.status, 503, metric);
    assert.equal((await response.json()).ok, false, metric);
  }
});

test('public meta exposes exactly twelve facets while assessment identities remain separate and non-filterable', async () => {
  const worker = await loadWorker();
  const env = makeTaxonomyApiEnv();
  const meta = await worker.fetch(new Request('https://curriculum.example/api/meta'), env);
  assert.equal(meta.status, 200);
  const body = await meta.json();
  assert.deepEqual(body.subjects.map((item) => item.name), displayFacetNames);
  assert.equal(body.subjects.some((item) => item.name === '汉语'), false);
  assert.deepEqual(body.queryIdentities.map((item) => item.name), ['语文']);
  assert.deepEqual(body.assessmentIdentities, [{
    name: '汉语',
    taxonomyEntityKind: 'assessment_subject',
    relatedDisplayFacet: '语文',
    documentCount: 1,
    firstYear: 2019,
    lastYear: 2019,
  }]);

  const assessmentFilter = await worker.fetch(
    new Request('https://curriculum.example/api/documents?subject=%E6%B1%89%E8%AF%AD'),
    env,
  );
  assert.equal(assessmentFilter.status, 400);
  assert.match((await assessmentFilter.json()).error, /精确分类身份不存在或不可检索/);

  const detail = await worker.fetch(
    new Request('https://curriculum.example/api/documents/neea-2019-05'),
    env,
  );
  assert.equal(detail.status, 200);
  const detailBody = await detail.json();
  assert.equal(detailBody.document.taxonomy_entity_kind, 'assessment_subject');
  assert.equal(detailBody.document.canonical_subject, '汉语');
  assert.equal(detailBody.document.display_facet, '语文');
});
