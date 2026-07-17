import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
const EMPTY_CORE_TABLE_COUNTS_JSON = JSON.stringify({
  subjects: 0,
  periods: 0,
  document_relations: 0,
  chapters: 0,
  document_classifications: 0,
  document_sources: 0,
  primary_document_sources: 0,
  subject_insights: 0,
  terms: 0,
  term_relations: 0,
  version_diffs: 0,
  online_verifications: 0,
  online_evidence: 0,
});

async function bundleModule(entryPoint) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(entryPoint, root))],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  });
  const encoded = Buffer.from(bundle.outputFiles[0].text).toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

let aiModulePromise;
function loadAiModule() {
  aiModulePromise ||= bundleModule('src/ai.ts');
  return aiModulePromise;
}

let workerPromise;
async function loadWorker() {
  workerPromise ||= bundleModule('src/index.ts').then((module) => module.default);
  return workerPromise;
}

test('AI citation validator accepts only deterministic non-factual exceptions', async () => {
  const { validateAiAnswerCitations } = await loadAiModule();
  const answer = [
    '## 原文事实',
    '2022年课程标准强调核心素养。[P:12]',
    '## 证据边界',
    '现有证据不足，无法确认地方实施情况。',
    '## 教学建议',
    '建议课堂中安排分层讨论。',
  ].join('\n');
  const result = validateAiAnswerCitations(answer, [12]);

  assert.equal(result.valid, true);
  assert.deepEqual(result.citedIds, [12]);
  assert.deepEqual(result.invalidCitationIds, []);
  assert.deepEqual(result.malformedCitations, []);
  assert.deepEqual(result.uncitedClaims, []);
});

test('AI citation validator attaches a citation only to the immediately preceding sentence on the same line', async () => {
  const { validateAiAnswerCitations } = await loadAiModule();

  assert.equal(validateAiAnswerCitations('事实句。[P:12]', [12]).valid, true);
  assert.equal(validateAiAnswerCitations('第一项事实。第二项事实。[P:12]', [12]).valid, false);
  assert.deepEqual(
    validateAiAnswerCitations('第一项事实。第二项事实。[P:12]', [12]).uncitedClaims,
    ['第一项事实。'],
  );
  assert.equal(validateAiAnswerCitations('第一项事实。\n[P:12]', [12]).valid, false);
  assert.deepEqual(
    validateAiAnswerCitations('First fact.[P:12] Second fact.', [12]).uncitedClaims,
    ['Second fact.'],
  );
  assert.equal(validateAiAnswerCitations('该指标为3.2。[P:12]', [12]).valid, true);
});

test('AI citation validator allows an uncertainty-only answer and formatting-only lines without citations', async () => {
  const { validateAiAnswerCitations } = await loadAiModule();
  const uncertainty = validateAiAnswerCitations('无法从现有证据确认该版本的地方实施情况。', [12]);
  const qualifiedUncertainty = validateAiAnswerCitations('现有证据仍不足，无法确认地方实施情况。', [12]);
  const formatting = validateAiAnswerCitations('---\n| --- | :---: |\n[P:12]', [12]);

  assert.equal(uncertainty.valid, true);
  assert.deepEqual(uncertainty.citedIds, []);
  assert.equal(qualifiedUncertainty.valid, true);
  assert.equal(formatting.valid, true);
  assert.deepEqual(formatting.citedIds, [12]);
});

test('AI citation validator fails closed on invalid, malformed, loose, or missing citations', async (t) => {
  const { validateAiAnswerCitations } = await loadAiModule();
  const cases = [
    {
      name: 'one valid citation does not cover a second uncited sentence',
      answer: '第一项事实。[P:12] 第二项事实。',
      check(result) {
        assert.deepEqual(result.uncitedClaims, ['第二项事实。']);
      },
    },
    {
      name: 'unretrieved paragraph id',
      answer: '第一项事实。[P:99]',
      check(result) {
        assert.deepEqual(result.invalidCitationIds, [99]);
      },
    },
    {
      name: 'malformed multi-id token',
      answer: '第一项事实。[P:12,13]',
      check(result) {
        assert.deepEqual(result.malformedCitations, ['[P:12,13]']);
      },
    },
    {
      name: 'loose unbracketed token',
      answer: '第一项事实 P:12',
      check(result) {
        assert.deepEqual(result.citedIds, []);
        assert.deepEqual(result.uncitedClaims, ['第一项事实 P:12']);
      },
    },
    {
      name: 'factual markdown heading',
      answer: '## 2022年课标明确要求核心素养',
      check(result) {
        assert.deepEqual(result.uncitedClaims, ['## 2022年课标明确要求核心素养']);
      },
    },
    {
      name: 'uncertainty wording cannot smuggle a factual assertion',
      answer: '证据不足，但2022年课标明确规定核心素养。',
      check(result) {
        assert.equal(result.uncitedClaims.length, 1);
      },
    },
    {
      name: 'uncertainty wording cannot append an assertion after another comma',
      answer: '证据不足，无法确认地方实施情况，2022年课标明确规定核心素养。',
      check(result) {
        assert.equal(result.uncitedClaims.length, 1);
      },
    },
    {
      name: 'suggestion label cannot smuggle a source assertion',
      answer: '建议依据2022年课标明确要求开展教学。',
      check(result) {
        assert.equal(result.uncitedClaims.length, 1);
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, () => {
      const result = validateAiAnswerCitations(item.answer, [12]);
      assert.equal(result.valid, false);
      item.check(result);
    });
  }
});

function makeAiEnv(answer, passageOverrides = {}) {
  const state = { logBindings: [], aiPrompt: null };
  const passage = {
    id: 12,
    document_id: 'doc-a',
    title: '测试课程标准',
    entity_kind: 'subject',
    taxonomy_entity_kind: 'subject',
    display_facet: '语文',
    subject: '语文',
    entity_label: '语文',
    subject_family: '语言',
    scope_kind: null,
    scope_label: null,
    version_label: '2022',
    page_number: 1,
    source_locator: '第1页',
    body: '测试证据正文。',
    source_url: 'https://example.invalid/source',
    score: 0,
    ...passageOverrides,
  };
  return {
    state,
    env: {
      DB: {
        prepare(sql) {
          const statement = {
            bindings: [],
            bind(...values) {
              this.bindings = values;
              return this;
            },
            async all() {
              if (sql.includes('FROM paragraph_fts')) return { results: [passage] };
              throw new Error(`Unexpected all query: ${sql}`);
            },
            async run() {
              if (sql.includes('INSERT INTO ai_citation_logs')) {
                state.logBindings.push(this.bindings);
                return { success: true };
              }
              throw new Error(`Unexpected run query: ${sql}`);
            },
          };
          return statement;
        },
      },
      APIS: {
        async fetch(request) {
          const body = JSON.parse(await request.text());
          state.aiPrompt = body.contents?.[0]?.parts?.[0]?.text || null;
          return Response.json({ answer });
        },
      },
      AI_ORIGIN: 'https://curriculum.example',
      AI_MODEL_LABEL: 'test',
    },
  };
}

test('answerWithEvidence uses sentence-level validation and logs fail-closed rejection', async () => {
  const { answerWithEvidence } = await loadAiModule();
  const { env, state } = makeAiEnv('第一项事实。[P:12] 第二项事实。');

  await assert.rejects(
    () => answerWithEvidence(
      env,
      { authenticated: false, user: null, admin: false },
      '比较课程标准的主要变化',
      '',
    ),
    (error) => error?.status === 502 && error.message === 'AI 回答未通过引文校验，请重试或直接查看检索证据',
  );
  assert.equal(state.logBindings.length, 1);
  assert.equal(state.logBindings[0].at(-1), 'citation_validation_failed');
});

test('answerWithEvidence permits a fully explicit uncertainty response with no fabricated citation', async () => {
  const { answerWithEvidence } = await loadAiModule();
  const { env, state } = makeAiEnv('现有证据不足，无法确认该版本的地方实施情况。');
  const result = await answerWithEvidence(
    env,
    { authenticated: false, user: null, admin: false },
    '比较课程标准的主要变化',
    '',
  );

  assert.deepEqual(result.citations, []);
  assert.equal(result.retrievalCount, 1);
  assert.equal(state.logBindings[0].at(-1), 'ok');
});

test('answerWithEvidence preserves curriculum-course and assessment-domain taxonomy in context and citations', async (t) => {
  const { answerWithEvidence } = await loadAiModule();
  const cases = [
    {
      name: 'curriculum course',
      passage: {
        entity_kind: 'scope', taxonomy_entity_kind: 'curriculum_course', display_facet: null,
        subject: null, entity_label: '技术', scope_kind: 'curriculum_course', scope_label: '技术',
      },
      promptIdentity: '课程：技术',
    },
    {
      name: 'assessment domain',
      passage: {
        entity_kind: 'scope', taxonomy_entity_kind: 'assessment_domain', display_facet: null,
        subject: null, entity_label: '学业质量', scope_kind: 'assessment_framework', scope_label: '学业质量',
      },
      promptIdentity: '考试评价范围：学业质量',
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const { env, state } = makeAiEnv('该证据说明一个可核验事实。[P:12]', item.passage);
      const result = await answerWithEvidence(
        env,
        { authenticated: false, user: null, admin: false },
        '比较课程标准的主要变化',
        '',
      );
      assert.match(state.aiPrompt, new RegExp(item.promptIdentity));
      assert.equal(result.citations.length, 1);
      assert.equal(result.citations[0].entityKind, item.passage.entity_kind);
      assert.equal(result.citations[0].taxonomyEntityKind, item.passage.taxonomy_entity_kind);
      assert.equal(result.citations[0].displayFacet, item.passage.display_facet);
    });
  }
});

function makeCommentEnv({ parent = null, paragraph = null, sources = {} } = {}) {
  const state = { queries: [], commentInsert: null };
  const DB = {
    prepare(sql) {
      const statement = {
        bindings: [],
        bind(...values) {
          this.bindings = values;
          return this;
        },
        async first() {
          state.queries.push({ operation: 'first', sql, bindings: this.bindings });
          if (sql.includes('FROM corpus_import_releases r')) return {
            release_id: 'corpus-test-ready',
            manifest_sha256: 'a'.repeat(64),
            state: 'ready',
            expected_documents: 1,
            expected_paragraphs: 1,
            expected_fts_rows: 1,
            expected_page_gates: 1,
            expected_displayed_paragraphs: 1,
            accepted_ocr_documents: 0,
            expected_chunks: 1,
            expected_core_counts_json: EMPTY_CORE_TABLE_COUNTS_JSON,
            actual_documents: 1,
            actual_paragraphs: 1,
            actual_fts_rows: 1,
            actual_page_gates: 1,
            actual_displayed_paragraphs: 1,
            actual_chunks: 1,
            actual_core_counts_json: EMPTY_CORE_TABLE_COUNTS_JSON,
            live_documents: 1,
            live_paragraphs: 1,
            live_fts_rows: 1,
            live_page_gates: 1,
            live_displayed_paragraphs: 1,
            live_accepted_ocr_documents: 0,
            live_chunks: 1,
            live_core_counts_json: EMPTY_CORE_TABLE_COUNTS_JSON,
          };
          if (sql.includes('SELECT id FROM documents')) return { id: 'doc-a' };
          if (sql.includes('SELECT id,document_id FROM comments')) return parent;
          if (sql.includes('SELECT id,document_id,display_allowed FROM paragraphs')) return paragraph;
          if (sql.includes('INSERT INTO rate_limits')) return { count: 1 };
          throw new Error(`Unexpected first query: ${sql}`);
        },
        async run() {
          state.queries.push({ operation: 'run', sql, bindings: this.bindings });
          if (sql.includes('INSERT INTO comments')) {
            state.commentInsert = this.bindings;
            return { success: true };
          }
          throw new Error(`Unexpected run query: ${sql}`);
        },
      };
      return statement;
    },
  };
  return {
    state,
    env: {
      DB,
      SITE_ORIGIN: 'https://curriculum.example',
      USER_CENTER_ORIGIN: 'https://my.bdfz.net',
      USER_CENTER: {
        async fetch() {
          return Response.json({
            authenticated: true,
            user: { slug: 'teacher', display_name: 'Teacher' },
          });
        },
      },
      HASH_SALT: 'test-hash-salt',
      ASSETS: { async fetch() { return new Response('asset'); } },
      SOURCES: sources,
      APIS: {},
      ENVIRONMENT: 'test',
      AI_ORIGIN: 'https://curriculum.example',
      AI_MODEL_LABEL: 'test',
      TURNSTILE_SITE_KEY: '',
    },
  };
}

function mockR2Object(input, contentType = 'application/json') {
  const bytes = Buffer.from(input);
  return {
    size: bytes.byteLength,
    httpEtag: `"${createHash('sha256').update(bytes).digest('hex')}"`,
    writeHttpMetadata(headers) {
      headers.set('content-type', contentType);
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

function commentRequest(body) {
  return new Request('https://curriculum.example/api/comments', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://curriculum.example',
      cookie: 'bdfz_uc_session=test',
    },
    body: JSON.stringify({
      documentId: 'doc-a',
      body: '这是一条用于测试的教师讨论。',
      ...body,
    }),
  });
}

test('comment creation rejects missing and cross-document parent references before rate limiting', async (t) => {
  const worker = await loadWorker();
  const cases = [
    {
      name: 'missing parent',
      parent: null,
      status: 404,
      error: '回复所引用的上级讨论不存在',
    },
    {
      name: 'parent from another document',
      parent: { id: 'parent-1', document_id: 'doc-b' },
      status: 400,
      error: '上级讨论不属于当前资料',
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const { env, state } = makeCommentEnv({ parent: item.parent });
      const response = await worker.fetch(commentRequest({ parentId: 'parent-1' }), env);
      assert.equal(response.status, item.status);
      assert.equal((await response.json()).error, item.error);
      assert.equal(state.queries.some((query) => query.sql.includes('INSERT INTO rate_limits')), false);
      assert.equal(state.commentInsert, null);
    });
  }
});

test('comment creation rejects missing, cross-document, and hidden paragraph references before rate limiting', async (t) => {
  const worker = await loadWorker();
  const cases = [
    {
      name: 'missing paragraph',
      paragraph: null,
      status: 404,
      error: '讨论所引用的段落不存在',
    },
    {
      name: 'paragraph from another document',
      paragraph: { id: 12, document_id: 'doc-b', display_allowed: 1 },
      status: 400,
      error: '段落不属于当前资料',
    },
    {
      name: 'paragraph blocked by publication gate',
      paragraph: { id: 12, document_id: 'doc-a', display_allowed: 0 },
      status: 409,
      error: '该段落尚未开放讨论',
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const { env, state } = makeCommentEnv({ paragraph: item.paragraph });
      const response = await worker.fetch(commentRequest({ paragraphId: 12 }), env);
      assert.equal(response.status, item.status);
      assert.equal((await response.json()).error, item.error);
      assert.equal(state.queries.some((query) => query.sql.includes('INSERT INTO rate_limits')), false);
      assert.equal(state.commentInsert, null);
    });
  }
});

test('comment creation rejects non-integer paragraph ids', async (t) => {
  const worker = await loadWorker();
  for (const paragraphId of ['12', 0, 1.5]) {
    await t.test(JSON.stringify(paragraphId), async () => {
      const { env, state } = makeCommentEnv();
      const response = await worker.fetch(commentRequest({ paragraphId }), env);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, '段落编号无效');
      assert.equal(state.queries.length, 1);
      assert.match(state.queries[0].sql, /FROM corpus_import_releases r/);
    });
  }
});

test('comment creation accepts same-document references and preserves authenticated rate limiting', async () => {
  const worker = await loadWorker();
  const { env, state } = makeCommentEnv({
    parent: { id: 'parent-1', document_id: 'doc-a' },
    paragraph: { id: 12, document_id: 'doc-a', display_allowed: 1 },
  });
  const response = await worker.fetch(commentRequest({ parentId: 'parent-1', paragraphId: 12 }), env);
  const result = await response.json();

  assert.equal(response.status, 201);
  assert.equal(result.status, 'approved');
  assert.equal(state.queries.some((query) => query.sql.includes('INSERT INTO rate_limits')), true);
  assert.deepEqual(state.commentInsert.slice(1), [
    'parent-1',
    'doc-a',
    12,
    'teacher',
    'Teacher',
    'authenticated',
    '这是一条用于测试的教师讨论。',
    'approved',
  ]);
});

test('source manifest follows the integrity-checked immutable release pointer', async () => {
  const worker = await loadWorker();
  const releaseId = `release-${'1'.repeat(32)}`;
  const assetBytes = Buffer.from('{"entries":[{"id":"versioned"}]}\n');
  const assetKey = `releases/${releaseId}/catalog/ingest-manifest.json`;
  const releaseManifestKey = `releases/${releaseId}/manifest.json`;
  const releaseManifestBytes = Buffer.from(`${JSON.stringify({
    schema_version: 1,
    release_id: releaseId,
    r2: {
      release_prefix: 'releases',
      release_manifest_key: releaseManifestKey,
      objects: [{
        key: 'catalog/ingest-manifest.json',
        release_key: assetKey,
        sha256: sha256(assetBytes),
        bytes: assetBytes.byteLength,
        content_type: 'application/json',
      }],
    },
  })}\n`);
  const pointerBytes = Buffer.from(`${JSON.stringify({
    schema_version: 1,
    release_id: releaseId,
    release_manifest_key: releaseManifestKey,
    release_manifest_sha256: sha256(releaseManifestBytes),
    release_manifest_bytes: releaseManifestBytes.byteLength,
    managed_object_count: 1,
  })}\n`);
  const calls = [];
  const objects = new Map([
    ['release/current.json', mockR2Object(pointerBytes)],
    [releaseManifestKey, mockR2Object(releaseManifestBytes)],
    [assetKey, mockR2Object(assetBytes)],
    ['catalog/ingest-manifest.json', mockR2Object('{"entries":[{"id":"stale"}]}\n')],
  ]);
  const { env } = makeCommentEnv({
    sources: {
      async get(key) {
        calls.push(key);
        return objects.get(key) || null;
      },
    },
  });
  const response = await worker.fetch(new Request('https://curriculum.example/api/source-manifest'), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { entries: [{ id: 'versioned' }] });
  assert.deepEqual(calls, ['release/current.json', releaseManifestKey, assetKey]);
});

test('source manifest retains a stable-key bootstrap fallback only when no release pointer exists', async () => {
  const worker = await loadWorker();
  const legacyBytes = Buffer.from('{"entries":[{"id":"legacy"}]}\n');
  const calls = [];
  const { env } = makeCommentEnv({
    sources: {
      async get(key) {
        calls.push(key);
        return key === 'catalog/ingest-manifest.json' ? mockR2Object(legacyBytes) : null;
      },
    },
  });
  const response = await worker.fetch(new Request('https://curriculum.example/api/source-manifest'), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { entries: [{ id: 'legacy' }] });
  assert.deepEqual(calls, ['release/current.json', 'catalog/ingest-manifest.json']);
});

test('source manifest never falls back to stale data when a pointed release drifts', async () => {
  const worker = await loadWorker();
  const releaseId = `release-${'2'.repeat(32)}`;
  const releaseManifestKey = `releases/${releaseId}/manifest.json`;
  const releaseManifestBytes = Buffer.from(`${JSON.stringify({
    schema_version: 1,
    release_id: releaseId,
    r2: {
      release_prefix: 'releases',
      release_manifest_key: releaseManifestKey,
      objects: [{
        key: 'catalog/ingest-manifest.json',
        release_key: `releases/${releaseId}/catalog/ingest-manifest.json`,
        sha256: '3'.repeat(64),
        bytes: 12,
        content_type: 'application/json',
      }],
    },
  })}\n`);
  const pointerBytes = Buffer.from(`${JSON.stringify({
    schema_version: 1,
    release_id: releaseId,
    release_manifest_key: releaseManifestKey,
    release_manifest_sha256: sha256(releaseManifestBytes),
    release_manifest_bytes: releaseManifestBytes.byteLength,
    managed_object_count: 1,
  })}\n`);
  const calls = [];
  const objects = new Map([
    ['release/current.json', mockR2Object(pointerBytes)],
    [releaseManifestKey, mockR2Object(releaseManifestBytes)],
    [`releases/${releaseId}/catalog/ingest-manifest.json`, mockR2Object('{"bad":true}\n')],
    ['catalog/ingest-manifest.json', mockR2Object('{"entries":[{"id":"stale"}]}\n')],
  ]);
  const { env } = makeCommentEnv({
    sources: {
      async get(key) {
        calls.push(key);
        return objects.get(key) || null;
      },
    },
  });
  const response = await worker.fetch(new Request('https://curriculum.example/api/source-manifest'), env);

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, '来源校验清单发布状态异常');
  assert.equal(calls.includes('catalog/ingest-manifest.json'), false);
});
