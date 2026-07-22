import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);

async function loadAdminModule() {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('src/admin.ts', root))],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}

let workerPromise;
async function loadWorker() {
  workerPromise ||= bundleWorker();
  return workerPromise;
}

async function bundleWorker() {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('src/index.ts', root))],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)).default;
}

const admin = { authenticated: true, user: { slug: 'editor' }, admin: true };
const teacher = { authenticated: true, user: { slug: 'teacher' }, admin: false };

function statementDb(handler) {
  return {
    prepare(sql) {
      return {
        bindings: [],
        bind(...values) {
          this.bindings = values;
          return this;
        },
        first() {
          return handler({ operation: 'first', sql, bindings: this.bindings });
        },
        all() {
          return handler({ operation: 'all', sql, bindings: this.bindings });
        },
        run() {
          return handler({ operation: 'run', sql, bindings: this.bindings });
        },
      };
    },
    batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
}

async function migratedSqlite() {
  const database = new DatabaseSync(':memory:');
  const migrationUrl = new URL('migrations/', root);
  for (const file of (await readdir(migrationUrl)).filter((name) => name.endsWith('.sql')).sort()) {
    database.exec(await readFile(new URL(file, migrationUrl), 'utf8'));
  }
  const wrap = (statement) => ({
    bindings: [],
    bind(...values) {
      this.bindings = values;
      return this;
    },
    first() {
      return statement.get(...this.bindings) || null;
    },
    all() {
      return { results: statement.all(...this.bindings) };
    },
    run() {
      const result = statement.run(...this.bindings);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  });
  return {
    database,
    d1: {
      prepare(sql) {
        return wrap(database.prepare(sql));
      },
      async batch(statements) {
        database.exec('BEGIN IMMEDIATE');
        try {
          const results = statements.map((statement) => statement.run());
          database.exec('COMMIT');
          return results;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      },
    },
  };
}

test('every admin control-plane function rejects a non-admin before querying D1', async () => {
  const module = await loadAdminModule();
  let queries = 0;
  const env = { DB: statementDb(() => { queries += 1; }) };
  const calls = [
    () => module.adminOverview(env, teacher),
    () => module.adminInventory(new URL('https://curriculum.example/api/admin/inventory?kind=documents'), env, teacher),
    () => module.adminComments(new URL('https://curriculum.example/api/admin/comments'), env, teacher),
    () => module.adminReports(new URL('https://curriculum.example/api/admin/reports'), env, teacher),
    () => module.adminAiLogs(new URL('https://curriculum.example/api/admin/ai-logs'), env, teacher),
    () => module.adminAudit(new URL('https://curriculum.example/api/admin/audit'), env, teacher),
  ];
  for (const call of calls) {
    await assert.rejects(call, (error) => error?.status === 403);
  }
  assert.equal(queries, 0);
});

test('Worker admin routes authenticate before any corpus or management D1 query', async (t) => {
  const worker = await loadWorker();
  for (const item of [
    { name: 'anonymous', cookie: '', status: 401, user: null },
    { name: 'authenticated non-admin', cookie: 'bdfz_uc_session=test', status: 403, user: { slug: 'teacher' } },
  ]) {
    await t.test(item.name, async () => {
      let dbQueries = 0;
      const response = await worker.fetch(new Request('https://curriculum.example/api/admin/overview', {
        headers: item.cookie ? { cookie: item.cookie } : {},
      }), {
        DB: { prepare() { dbQueries += 1; throw new Error('D1 must not be queried'); } },
        USER_CENTER: {
          fetch() {
            return Response.json({ authenticated: Boolean(item.user), user: item.user });
          },
        },
        SITE_ORIGIN: 'https://curriculum.example',
        USER_CENTER_ORIGIN: 'https://my.bdfz.net',
      });
      assert.equal(response.status, item.status);
      assert.equal(dbQueries, 0);
    });
  }
});

test('admin inventory accepts only an allowlisted entity kind and parameterizes search', async () => {
  const module = await loadAdminModule();
  const calls = [];
  const env = {
    DB: statementDb(async (call) => {
      calls.push(call);
      if (call.operation === 'first') return { count: 1 };
      return { results: [{ id: 'doc-a', title: '语文课程标准' }] };
    }),
  };

  const response = await module.adminInventory(
    new URL('https://curriculum.example/api/admin/inventory?kind=documents&q=%25_%5C&limit=20&offset=0'),
    env,
    admin,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.kind, 'documents');
  assert.equal(body.total, 1);
  assert.equal(body.rows.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.sql.includes("ESCAPE '\\'")), true);
  assert.equal(calls.every((call) => call.bindings[0] === '%\\%\\_\\\\%'), true);

  await assert.rejects(
    () => module.adminInventory(
      new URL('https://curriculum.example/api/admin/inventory?kind=sqlite_master'), env, admin,
    ),
    (error) => error?.status === 400 && /资料类型/.test(error.message),
  );
});

test('admin report resolution is same-origin, validates the action, and writes one audit transaction', async () => {
  const module = await loadAdminModule();
  const queries = [];
  const env = {
    SITE_ORIGIN: 'https://curriculum.example',
    DB: statementDb(async (call) => {
      queries.push(call);
      if (call.operation === 'first' && call.sql.includes('FROM comment_reports')) {
        return { id: 'report-1', comment_id: 'comment-1', report_status: 'open', comment_status: 'approved' };
      }
      if (call.operation === 'run') return { success: true, meta: { changes: 1 } };
      throw new Error(`unexpected query: ${call.sql}`);
    }),
  };
  const request = new Request('https://curriculum.example/api/admin/reports/report-1', {
    method: 'PATCH',
    headers: { origin: 'https://curriculum.example', 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'resolved', note: '重复举报，保留原讨论', commentStatus: 'approved' }),
  });
  const response = await module.resolveAdminReport(request, env, admin, 'report-1');
  assert.equal(response.status, 200);
  assert.equal(queries.filter((entry) => entry.operation === 'run').length, 4);
  const audit = queries.find((entry) => entry.operation === 'run' && entry.sql.includes('content_audit_log'));
  assert.equal(audit.bindings[1], 'editor');
  assert.equal(audit.bindings[2], 'resolve_report');
  assert.equal(audit.bindings[3], 'comment_report');
  assert.equal(audit.bindings[4], 'report-1');

  await assert.rejects(
    () => module.resolveAdminReport(new Request(request.url, {
      method: 'PATCH',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'resolved', note: '重复举报，保留原讨论' }),
    }), env, admin, 'report-1'),
    (error) => error?.status === 403,
  );

  const incompleteEnv = {
    SITE_ORIGIN: 'https://curriculum.example',
    DB: {
      ...statementDb(async (call) => {
        if (call.operation === 'first') {
          return { id: 'report-1', comment_id: 'comment-1', report_status: 'open', comment_status: 'approved' };
        }
        return { success: true, meta: { changes: 1 } };
      }),
      async batch(statements) {
        const results = await Promise.all(statements.map((statement) => statement.run()));
        results[2] = { success: true, meta: { changes: 0 } };
        return results;
      },
    },
  };
  await assert.rejects(
    () => module.resolveAdminReport(new Request(request.url, {
      method: 'PATCH',
      headers: { origin: 'https://curriculum.example', 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'resolved', note: '重复举报，保留原讨论', commentStatus: 'approved' }),
    }), incompleteEnv, admin, 'report-1'),
    (error) => error?.status === 409 && /审计事务/.test(error.message),
  );
});

test('AI administration never returns actor or query hashes', async () => {
  const module = await loadAdminModule();
  const env = {
    DB: statementDb(async (call) => {
      if (call.operation === 'first') return { count: 1 };
      return {
        results: [{
          id: 'ai-1', actor_hash: 'private-actor', query_hash: 'private-query',
          subject_filter: '语文', retrieved_paragraph_ids: '[1,2]', cited_paragraph_ids: '[2]',
          model_label: 'model', status: 'citation_validation_failed', created_at: '2026-07-22 00:00:00',
        }],
      };
    }),
  };
  const response = await module.adminAiLogs(
    new URL('https://curriculum.example/api/admin/ai-logs?status=failed'), env, admin,
  );
  const body = await response.json();
  assert.deepEqual(body.rows, [{
    id: 'ai-1', subject_filter: '语文', model_label: 'model',
    status: 'citation_validation_failed', created_at: '2026-07-22 00:00:00',
    retrieved_count: 2, cited_count: 1,
  }]);
  assert.equal(JSON.stringify(body).includes('private-actor'), false);
  assert.equal(JSON.stringify(body).includes('private-query'), false);
});

test('every admin read and report write executes against the real migrated schema', async () => {
  const module = await loadAdminModule();
  const { database, d1 } = await migratedSqlite();
  const env = { DB: d1, SITE_ORIGIN: 'https://curriculum.example' };
  try {
    for (const call of [
      () => module.adminOverview(env, admin),
      ...['documents', 'chapters', 'paragraphs', 'terms', 'relations', 'versions', 'evidence']
        .map((kind) => () => module.adminInventory(
          new URL(`https://curriculum.example/api/admin/inventory?kind=${kind}`), env, admin,
        )),
      () => module.adminComments(new URL('https://curriculum.example/api/admin/comments'), env, admin),
      () => module.adminReports(new URL('https://curriculum.example/api/admin/reports'), env, admin),
      () => module.adminAiLogs(new URL('https://curriculum.example/api/admin/ai-logs'), env, admin),
      () => module.adminAudit(new URL('https://curriculum.example/api/admin/audit'), env, admin),
    ]) assert.equal((await call()).status, 200);

    database.exec(`INSERT INTO documents(
      id,title,subject,stage,document_type,version_label,issued_by,current_status,source_tier,
      access_status,source_page_url,source_url,file_format,redistribution
    ) VALUES('doc-a','测试资料','语文','高中','课程标准','2020','教育部','current_reference',
      'primary_official','available','https://example.test/page','https://example.test/file.pdf','pdf','metadata_only');
    INSERT INTO comments(id,document_id,author_name,author_kind,body,status)
      VALUES('comment-1','doc-a','匿名教师','anonymous','用于真实 schema 测试的讨论','approved');
    INSERT INTO comment_reports(id,comment_id,reason,status)
      VALUES('report-1','comment-1','用于真实 schema 测试的举报','open');`);
    const response = await module.resolveAdminReport(new Request(
      'https://curriculum.example/api/admin/reports/report-1', {
        method: 'PATCH',
        headers: { origin: 'https://curriculum.example', 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'resolved', note: '核查后保留讨论', commentStatus: 'approved' }),
      },
    ), env, admin, 'report-1');
    assert.equal(response.status, 200);
    assert.equal(database.prepare("SELECT status FROM comment_reports WHERE id='report-1'").get().status, 'resolved');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM content_audit_log').get().count, 1);
    await assert.rejects(
      () => module.resolveAdminReport(new Request(
        'https://curriculum.example/api/admin/reports/report-1', {
          method: 'PATCH',
          headers: { origin: 'https://curriculum.example', 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'dismissed', note: '重复处理应当失败' }),
        },
      ), env, admin, 'report-1'),
      (error) => error?.status === 409,
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM content_audit_log').get().count, 1);
  } finally {
    database.close();
  }
});

test('admin frontend exposes overview, inventory, reports, AI, and audit without direct corpus mutation controls', async () => {
  const source = await readFile(new URL('public/app.js', root), 'utf8');
  for (const endpoint of [
    '/api/admin/overview', '/api/admin/inventory', '/api/admin/comments',
    '/api/admin/reports', '/api/admin/ai-logs', '/api/admin/audit',
  ]) assert.match(source, new RegExp(endpoint.replaceAll('/', '\\/')));
  assert.doesNotMatch(source, /data-admin-(?:import|reindex|edit-live)/);
  assert.match(source, /不可直接修改已发布语料/);
});
