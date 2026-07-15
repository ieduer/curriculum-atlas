import { answerWithEvidence } from './ai';
import { getSession, requireAdmin, requireAuthenticated } from './auth';
import { clampInt, HttpError, json, readJson, requireSameOrigin, secureHeaders, textParam } from './http';
import { retrieve } from './retrieval';
import { enforceRateLimit, verifyTurnstile } from './security';
import type { Env, Session } from './types';

const VERSION = '2026.07.15-v3';

interface CommentInput {
  documentId?: string;
  paragraphId?: number;
  parentId?: string;
  authorName?: string;
  body?: string;
  turnstileToken?: string;
}

interface AiInput {
  query?: string;
  subject?: string;
}

function cacheJson(data: unknown, seconds = 300): Response {
  return json(data, 200, { 'cache-control': `public, max-age=${seconds}, stale-while-revalidate=${seconds * 4}` });
}

async function health(env: Env): Promise<Response> {
  const row = await env.DB.prepare("SELECT value FROM site_meta WHERE key = 'schema_version'").first<{ value: string }>();
  return json({
    ok: row?.value === '3',
    service: 'bdfz-curriculum-atlas',
    version: VERSION,
    environment: env.ENVIRONMENT,
    schemaVersion: row?.value || null,
    bindings: {
      d1: Boolean(env.DB),
      r2: Boolean(env.SOURCES),
      apis: Boolean(env.APIS),
      userCenter: Boolean(env.USER_CENTER),
      assets: Boolean(env.ASSETS),
    },
  }, row?.value === '3' ? 200 : 503);
}

async function meta(env: Env): Promise<Response> {
  const [documents, paragraphs, comments, citationReady, onlineVerified, subjects, periods] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS count FROM documents').first<{ count: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM paragraphs').first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM comments WHERE status = 'approved'").first<{ count: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM documents WHERE citation_allowed = 1').first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM online_verifications WHERE verification_status IN ('verified_exact','verified_stable_fact_only')").first<{ count: number }>(),
    env.DB.prepare(`SELECT subject AS name, COUNT(*) AS documentCount, MIN(sort_year) AS firstYear, MAX(sort_year) AS lastYear
      FROM documents WHERE subject NOT IN ('课程方案','考试大纲') GROUP BY subject ORDER BY documentCount DESC, subject`).all(),
    env.DB.prepare('SELECT * FROM periods ORDER BY sort_order').all(),
  ]);
  return cacheJson({
    siteKey: 'curriculum',
    title: '中国历年课程标准与考试评价演变',
    version: VERSION,
    dataClass: 'teacher_owned',
    currentVersionNote: '现行标签依据已核验的教育部公开目录；处于修订过程的版本标注 revision watch。',
    counts: {
      documents: documents?.count || 0,
      paragraphs: paragraphs?.count || 0,
      comments: comments?.count || 0,
      citationReadyDocuments: citationReady?.count || 0,
      onlineVerifications: onlineVerified?.count || 0,
    },
    subjects: subjects.results,
    periods: periods.results,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
  }, 300);
}

async function listDocuments(url: URL, env: Env): Promise<Response> {
  const subject = textParam(url.searchParams.get('subject'), 40);
  const stage = textParam(url.searchParams.get('stage'), 40);
  const status = textParam(url.searchParams.get('status'), 40);
  const type = textParam(url.searchParams.get('type'), 40);
  const limit = clampInt(url.searchParams.get('limit'), 100, 1, 200);
  const result = await env.DB.prepare(
    `SELECT id,title,subject,stage,document_type,version_label,issued_by,issued_date,published_date,current_status,
            source_tier,access_status,source_page_url,source_url,file_format,redistribution,checksum_sha256,note,period_id,sort_year,
            text_quality_status,ocr_engine,ocr_audit_ref,citation_allowed,page_count
     FROM documents
     WHERE (? = '' OR subject = ?) AND (? = '' OR stage = ?) AND (? = '' OR current_status = ?) AND (? = '' OR document_type = ?)
     ORDER BY COALESCE(sort_year, 0) DESC, subject, title LIMIT ?`,
  ).bind(subject, subject, stage, stage, status, status, type, type, limit).all();
  return cacheJson({ documents: result.results }, 600);
}

async function documentDetail(id: string, url: URL, env: Env): Promise<Response> {
  const document = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();
  if (!document) throw new HttpError(404, '未找到该资料');
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100_000);
  const limit = clampInt(url.searchParams.get('limit'), 80, 1, 200);
  const [paragraphs, related, insights, verificationRows] = await Promise.all([
    env.DB.prepare(`SELECT id,ordinal,page_number,heading,body,source_locator,text_quality_status,ocr_quality_score,citation_allowed,
      online_verification_status,evidence_triad_status,uncertainty_note FROM paragraphs
      WHERE document_id = ? ORDER BY ordinal LIMIT ? OFFSET ?`).bind(id, limit, offset).all(),
    env.DB.prepare(`SELECT dr.relation_type, dr.note, d.id, d.title, d.subject, d.version_label
      FROM document_relations dr JOIN documents d ON d.id = dr.target_document_id WHERE dr.source_document_id = ?`).bind(id).all(),
    env.DB.prepare(`SELECT * FROM subject_insights WHERE evidence_document_ids LIKE ? ORDER BY sort_order`).bind(`%"${id}"%`).all(),
    env.DB.prepare(`SELECT v.*, e.id AS evidence_id, e.role AS evidence_role, e.publisher AS evidence_publisher,
        e.source_type AS evidence_source_type, e.source_title AS evidence_source_title, e.source_url AS evidence_source_url,
        e.published_at AS evidence_published_at, e.retrieved_at AS evidence_retrieved_at,
        e.version_match AS evidence_version_match, e.fact_summary AS evidence_fact_summary
      FROM online_verifications v LEFT JOIN online_evidence e ON e.verification_id = v.id
      WHERE v.document_id = ? ORDER BY v.physical_page, v.id, e.id`).bind(id).all(),
  ]);
  const verifications = new Map<string, Record<string, unknown> & { evidence: unknown[] }>();
  for (const row of verificationRows.results as Array<Record<string, unknown>>) {
    const verificationId = String(row.id);
    if (!verifications.has(verificationId)) {
      const verification: Record<string, unknown> & { evidence: unknown[] } = { ...row, evidence: [] };
      for (const key of Object.keys(verification)) if (key.startsWith('evidence_')) delete verification[key];
      verifications.set(verificationId, verification);
    }
    if (row.evidence_id) {
      verifications.get(verificationId)?.evidence.push({
        id: row.evidence_id,
        role: row.evidence_role,
        publisher: row.evidence_publisher,
        sourceType: row.evidence_source_type,
        sourceTitle: row.evidence_source_title,
        sourceUrl: row.evidence_source_url,
        publishedAt: row.evidence_published_at,
        retrievedAt: row.evidence_retrieved_at,
        versionMatch: row.evidence_version_match,
        factSummary: row.evidence_fact_summary,
      });
    }
  }
  return cacheJson({
    document,
    paragraphs: paragraphs.results,
    related: related.results,
    insights: insights.results,
    verifications: [...verifications.values()],
    offset,
    limit,
  }, 600);
}

async function search(url: URL, env: Env): Promise<Response> {
  const query = textParam(url.searchParams.get('q'), 240);
  if (query.length < 2) throw new HttpError(400, '请输入至少两个字符');
  const passages = await retrieve(env, {
    query,
    subject: textParam(url.searchParams.get('subject'), 40),
    stage: textParam(url.searchParams.get('stage'), 40),
    limit: clampInt(url.searchParams.get('limit'), 12, 1, 20),
  });
  return json({ query, passages });
}

async function insights(url: URL, env: Env): Promise<Response> {
  const subject = textParam(url.searchParams.get('subject'), 40);
  const result = await env.DB.prepare(`SELECT * FROM subject_insights WHERE (? = '' OR subject IN (?, '综合')) ORDER BY sort_order`)
    .bind(subject, subject).all();
  return cacheJson({ insights: result.results }, 600);
}

async function terminology(env: Env): Promise<Response> {
  const [terms, relations] = await Promise.all([
    env.DB.prepare('SELECT * FROM terms ORDER BY COALESCE(first_seen_year, 9999), label').all(),
    env.DB.prepare(`SELECT tr.*, s.label AS source_label, t.label AS target_label
      FROM term_relations tr JOIN terms s ON s.id = tr.source_term_id JOIN terms t ON t.id = tr.target_term_id
      ORDER BY tr.weight DESC`).all(),
  ]);
  return cacheJson({ terms: terms.results, relations: relations.results }, 900);
}

async function compare(url: URL, env: Env): Promise<Response> {
  const subject = textParam(url.searchParams.get('subject'), 40);
  if (!subject) throw new HttpError(400, '请选择学科');
  const [documents, insights] = await Promise.all([
    env.DB.prepare(`SELECT id,title,version_label,stage,sort_year,current_status,source_url FROM documents
      WHERE subject = ? ORDER BY sort_year`).bind(subject).all(),
    env.DB.prepare(`SELECT * FROM subject_insights WHERE subject IN (?, '综合') ORDER BY sort_order`).bind(subject).all(),
  ]);
  return cacheJson({ subject, documents: documents.results, insights: insights.results }, 600);
}

async function me(request: Request, env: Env): Promise<Response> {
  return json(await getSession(request, env));
}

async function listComments(url: URL, env: Env, session: Session): Promise<Response> {
  const documentId = textParam(url.searchParams.get('documentId'), 80);
  const paragraphId = clampInt(url.searchParams.get('paragraphId'), 0, 0, 1_000_000_000);
  const includePending = session.admin && url.searchParams.get('moderation') === '1';
  const result = await env.DB.prepare(
    `SELECT id,parent_id,document_id,paragraph_id,author_name,author_kind,body,status,created_at,updated_at
     FROM comments
     WHERE (? = '' OR document_id = ?)
       AND (? = 0 OR paragraph_id = ?)
       AND (${includePending ? "status IN ('pending','approved')" : "status = 'approved'"})
     ORDER BY created_at DESC LIMIT 100`,
  ).bind(documentId, documentId, paragraphId, paragraphId).all();
  return json({ comments: result.results });
}

async function createComment(request: Request, env: Env, session: Session): Promise<Response> {
  requireSameOrigin(request, env);
  const input = await readJson<CommentInput>(request);
  const documentId = textParam(input.documentId || '', 80);
  const body = textParam(input.body || '', 2_000);
  if (!documentId) throw new HttpError(400, '缺少资料编号');
  if (body.length < 8) throw new HttpError(400, '讨论内容至少 8 个字符');
  const document = await env.DB.prepare('SELECT id FROM documents WHERE id = ?').bind(documentId).first();
  if (!document) throw new HttpError(404, '讨论所引用的资料不存在');
  let authorSlug: string | null = null;
  let authorName: string;
  let authorKind: 'authenticated' | 'anonymous';
  let status: 'approved' | 'pending';
  if (session.authenticated && session.user) {
    authorSlug = session.user.slug;
    authorName = session.user.display_name || session.user.name || session.user.slug;
    authorKind = 'authenticated';
    status = 'approved';
    await enforceRateLimit(env, 'comment-auth', authorSlug, 12, 600);
  } else {
    authorName = textParam(input.authorName || '匿名教师', 40) || '匿名教师';
    authorKind = 'anonymous';
    status = 'pending';
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    await enforceRateLimit(env, 'comment-anon', ip, 3, 3600);
    await verifyTurnstile(request, env, textParam(input.turnstileToken || '', 2048));
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO comments(id,parent_id,document_id,paragraph_id,author_slug,author_name,author_kind,body,status)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).bind(id, input.parentId || null, documentId, input.paragraphId || null, authorSlug, authorName, authorKind, body, status).run();
  console.log(JSON.stringify({ event: 'comment_created', id, authorKind, status, documentId }));
  return json({ ok: true, id, status, message: status === 'pending' ? '已提交，审核后公开' : '讨论已发布' }, 201);
}

async function reportComment(request: Request, env: Env, session: Session, id: string): Promise<Response> {
  requireSameOrigin(request, env);
  const input = await readJson<{ reason?: string }>(request);
  const reason = textParam(input.reason || '', 240);
  if (reason.length < 4) throw new HttpError(400, '请说明举报原因');
  const actor = session.user?.slug || request.headers.get('cf-connecting-ip') || 'unknown';
  await enforceRateLimit(env, 'comment-report', actor, 5, 3600);
  const exists = await env.DB.prepare("SELECT id FROM comments WHERE id = ? AND status = 'approved'").bind(id).first();
  if (!exists) throw new HttpError(404, '讨论不存在');
  await env.DB.prepare('INSERT INTO comment_reports(id,comment_id,reporter_slug,reason) VALUES(?,?,?,?)')
    .bind(crypto.randomUUID(), id, session.user?.slug || null, reason).run();
  return json({ ok: true });
}

async function moderateComment(request: Request, env: Env, session: Session, id: string): Promise<Response> {
  requireSameOrigin(request, env);
  const admin = requireAdmin(session);
  const input = await readJson<{ status?: string; note?: string }>(request);
  if (!['approved', 'rejected', 'deleted'].includes(input.status || '')) throw new HttpError(400, '审核状态无效');
  const before = await env.DB.prepare('SELECT status,moderation_note FROM comments WHERE id = ?').bind(id).first();
  if (!before) throw new HttpError(404, '讨论不存在');
  await env.DB.batch([
    env.DB.prepare('UPDATE comments SET status = ?, moderation_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(input.status, textParam(input.note || '', 240) || null, id),
    env.DB.prepare(`INSERT INTO content_audit_log(id,actor_slug,action,entity_type,entity_id,before_json,after_json)
      VALUES(?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), admin.slug, 'moderate', 'comment', id, JSON.stringify(before), JSON.stringify(input)),
  ]);
  return json({ ok: true });
}

async function adminSummary(env: Env, session: Session): Promise<Response> {
  requireAdmin(session);
  const [pending, reports, aiFailures, audits] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM comments WHERE status = 'pending'").first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM comment_reports WHERE status = 'open'").first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM ai_citation_logs WHERE status != 'ok' AND created_at >= datetime('now','-7 days')").first(),
    env.DB.prepare('SELECT * FROM content_audit_log ORDER BY created_at DESC LIMIT 50').all(),
  ]);
  return json({ pending, reports, aiFailures, audits: audits.results });
}

async function aiChat(request: Request, env: Env, session: Session): Promise<Response> {
  requireSameOrigin(request, env);
  const user = requireAuthenticated(session);
  await enforceRateLimit(env, 'ai-chat', user.slug, 12, 600);
  const input = await readJson<AiInput>(request, 12_000);
  const query = textParam(input.query || '', 1_200);
  const subject = textParam(input.subject || '', 40);
  if (query.length < 8) throw new HttpError(400, '问题至少需要 8 个字符');
  return json(await answerWithEvidence(env, session, query, subject));
}

async function sourceManifest(env: Env): Promise<Response> {
  const object = await env.SOURCES.get('catalog/ingest-manifest.json');
  if (!object) throw new HttpError(404, '来源校验清单尚未发布');
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=3600');
  return new Response(object.body, { headers });
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = request.method;
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { allow: 'GET, POST, PATCH, OPTIONS' } });
  if (pathname === '/api/health' && method === 'GET') return health(env);
  if (pathname === '/api/meta' && method === 'GET') return meta(env);
  if (pathname === '/api/documents' && method === 'GET') return listDocuments(url, env);
  const detailMatch = pathname.match(/^\/api\/documents\/([a-z0-9-]+)$/);
  if (detailMatch && method === 'GET') return documentDetail(detailMatch[1], url, env);
  if (pathname === '/api/search' && method === 'GET') return search(url, env);
  if (pathname === '/api/insights' && method === 'GET') return insights(url, env);
  if (pathname === '/api/terms' && method === 'GET') return terminology(env);
  if (pathname === '/api/compare' && method === 'GET') return compare(url, env);
  if (pathname === '/api/source-manifest' && method === 'GET') return sourceManifest(env);
  if (pathname === '/api/me' && method === 'GET') return me(request, env);

  const needsSession = pathname.startsWith('/api/comments') || pathname.startsWith('/api/ai') || pathname.startsWith('/api/admin');
  const session = needsSession ? await getSession(request, env) : { authenticated: false, user: null, admin: false };
  if (pathname === '/api/comments' && method === 'GET') return listComments(url, env, session);
  if (pathname === '/api/comments' && method === 'POST') return createComment(request, env, session);
  const reportMatch = pathname.match(/^\/api\/comments\/([a-f0-9-]+)\/report$/);
  if (reportMatch && method === 'POST') return reportComment(request, env, session, reportMatch[1]);
  const moderateMatch = pathname.match(/^\/api\/admin\/comments\/([a-f0-9-]+)$/);
  if (moderateMatch && method === 'PATCH') return moderateComment(request, env, session, moderateMatch[1]);
  if (pathname === '/api/admin/summary' && method === 'GET') return adminSummary(env, session);
  if (pathname === '/api/ai/chat' && method === 'POST') return aiChat(request, env, session);
  throw new HttpError(404, 'API 路径不存在');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    try {
      const response = url.pathname.startsWith('/api/')
        ? await api(request, env, url)
        : await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.set('x-request-id', requestId);
      return secureHeaders(new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
    } catch (error) {
      if (error instanceof HttpError) return secureHeaders(json({ error: error.message, requestId }, error.status));
      console.error(JSON.stringify({ event: 'request_error', requestId, path: url.pathname, error: String(error) }));
      return secureHeaders(json({ error: '服务暂时不可用', requestId }, 500));
    }
  },
} satisfies ExportedHandler<Env>;
