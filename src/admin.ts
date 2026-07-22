import { requireAdmin } from './auth';
import { clampInt, HttpError, json, readJson, requireSameOrigin, textParam } from './http';
import type { Env, Session } from './types';

type InventoryKind = 'documents' | 'chapters' | 'paragraphs' | 'terms' | 'relations' | 'versions' | 'evidence';

interface InventoryDefinition {
  from: string;
  select: string;
  filter: string;
  order: string;
}

const INVENTORIES: Record<InventoryKind, InventoryDefinition> = {
  documents: {
    from: 'FROM documents d',
    select: `d.id,d.title,d.subject,d.stage,d.version_label,d.document_type,d.current_status,
      d.text_quality_status,d.citation_allowed,d.page_count,d.corpus_release_id`,
    filter: "(d.id LIKE ? ESCAPE '\\' OR d.title LIKE ? ESCAPE '\\')",
    order: 'd.sort_year DESC,d.title,d.id',
  },
  chapters: {
    from: 'FROM chapters c JOIN documents d ON d.id=c.document_id',
    select: 'c.id,c.document_id,d.title AS document_title,c.title,c.ordinal,c.page_start',
    filter: "(c.id LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\' OR d.title LIKE ? ESCAPE '\\')",
    order: 'd.sort_year DESC,c.document_id,c.ordinal,c.id',
  },
  paragraphs: {
    from: 'FROM paragraphs p JOIN documents d ON d.id=p.document_id',
    select: `p.id,p.document_id,d.title AS document_title,p.chapter_id,p.ordinal,p.page_number,p.source_locator,
      p.text_quality_status,p.display_allowed,p.citation_allowed,p.online_verification_status,
      p.evidence_triad_status,p.uncertainty_note,p.corpus_release_id,substr(p.body,1,360) AS excerpt`,
    filter: "(CAST(p.id AS TEXT) LIKE ? ESCAPE '\\' OR d.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\')",
    order: 'p.document_id,p.ordinal,p.id',
  },
  terms: {
    from: 'FROM terms t',
    select: 't.id,t.label,t.definition,t.first_seen_year,t.category,t.evidence_document_ids',
    filter: "(t.id LIKE ? ESCAPE '\\' OR t.label LIKE ? ESCAPE '\\' OR t.definition LIKE ? ESCAPE '\\')",
    order: 'COALESCE(t.first_seen_year,9999),t.label,t.id',
  },
  relations: {
    from: `FROM term_relations tr
      JOIN terms source ON source.id=tr.source_term_id
      JOIN terms target ON target.id=tr.target_term_id`,
    select: `tr.id,tr.source_term_id,source.label AS source_label,tr.target_term_id,target.label AS target_label,
      tr.relation_type,tr.weight,tr.evidence_document_ids`,
    filter: "(tr.id LIKE ? ESCAPE '\\' OR source.label LIKE ? ESCAPE '\\' OR target.label LIKE ? ESCAPE '\\')",
    order: 'tr.weight DESC,tr.id',
  },
  versions: {
    from: `FROM version_diffs vd
      JOIN documents source ON source.id=vd.from_document_id
      JOIN documents target ON target.id=vd.to_document_id`,
    select: `vd.id,vd.subject,vd.from_document_id,source.title AS from_title,vd.to_document_id,
      target.title AS to_title,vd.dimension,vd.summary,vd.review_status,vd.evidence_json`,
    filter: "(vd.id LIKE ? ESCAPE '\\' OR vd.subject LIKE ? ESCAPE '\\' OR vd.summary LIKE ? ESCAPE '\\')",
    order: 'vd.subject,vd.id',
  },
  evidence: {
    from: 'FROM page_publication_gates pg JOIN documents d ON d.id=pg.document_id',
    select: `pg.document_id,d.title AS document_title,pg.page_number,pg.display_allowed,pg.citation_allowed,
      pg.review_status,pg.evidence_bundle_sha256,pg.corpus_release_id`,
    filter: "(pg.document_id LIKE ? ESCAPE '\\' OR d.title LIKE ? ESCAPE '\\' OR pg.review_status LIKE ? ESCAPE '\\')",
    order: 'pg.document_id,pg.page_number',
  },
};

function likePattern(query: string): string {
  return `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

function repeated(value: string, count: number): string[] {
  return Array.from({ length: count }, () => value);
}

function placeholderCount(filter: string): number {
  return [...filter].filter((character) => character === '?').length;
}

function safeArrayCount(value: unknown): number {
  if (typeof value !== 'string' || value.length > 100_000) return 0;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export async function adminOverview(env: Env, session: Session): Promise<Response> {
  requireAdmin(session);
  const [
    documents, chapters, paragraphs, fts, terms, relations, versions, pageGates,
    comments, reports, ai, release,
  ] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS count FROM documents').first(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM chapters').first(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM paragraphs').first(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM paragraph_fts').first(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM terms').first(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM term_relations').first(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM version_diffs').first(),
    env.DB.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN display_allowed=1 THEN 1 ELSE 0 END) AS display_allowed,
      SUM(CASE WHEN citation_allowed=1 THEN 1 ELSE 0 END) AS citation_allowed
      FROM page_publication_gates`).first(),
    env.DB.prepare('SELECT status,COUNT(*) AS count FROM comments GROUP BY status ORDER BY status').all(),
    env.DB.prepare('SELECT status,COUNT(*) AS count FROM comment_reports GROUP BY status ORDER BY status').all(),
    env.DB.prepare(`SELECT CASE WHEN status='ok' THEN 'ok' ELSE 'failed' END AS status,COUNT(*) AS count
      FROM ai_citation_logs WHERE created_at>=datetime('now','-7 days') GROUP BY 1 ORDER BY 1`).all(),
    env.DB.prepare(`SELECT release_id,state,manifest_sha256,expected_documents,expected_paragraphs,
      expected_fts_rows,expected_page_gates,expected_chunks,accepted_ocr_documents,ready_at,updated_at
      FROM corpus_import_releases
      WHERE release_id=(SELECT value FROM site_meta WHERE key='current_corpus_release_id')`).first(),
  ]);
  return json({
    counts: {
      documents: Number(documents?.count || 0),
      chapters: Number(chapters?.count || 0),
      paragraphs: Number(paragraphs?.count || 0),
      fts: Number(fts?.count || 0),
      terms: Number(terms?.count || 0),
      relations: Number(relations?.count || 0),
      versions: Number(versions?.count || 0),
    },
    pageGates: pageGates || {},
    comments: comments.results,
    reports: reports.results,
    ai: ai.results,
    release: release || null,
    mutationPolicy: 'immutable_release_pipeline_only',
  });
}

export async function adminInventory(url: URL, env: Env, session: Session): Promise<Response> {
  requireAdmin(session);
  const kind = textParam(url.searchParams.get('kind'), 24) as InventoryKind;
  const definition = INVENTORIES[kind];
  if (!definition) throw new HttpError(400, '管理资料类型无效');
  const query = textParam(url.searchParams.get('q'), 160);
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000);
  const pattern = likePattern(query);
  const bindings = repeated(pattern, placeholderCount(definition.filter));
  const [count, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count ${definition.from} WHERE ${definition.filter}`)
      .bind(...bindings).first<{ count: number }>(),
    env.DB.prepare(`SELECT ${definition.select} ${definition.from} WHERE ${definition.filter}
      ORDER BY ${definition.order} LIMIT ? OFFSET ?`).bind(...bindings, limit, offset).all(),
  ]);
  return json({
    kind,
    query,
    total: Number(count?.count || 0),
    limit,
    offset,
    rows: rows.results,
  });
}

export async function adminComments(url: URL, env: Env, session: Session): Promise<Response> {
  requireAdmin(session);
  const status = textParam(url.searchParams.get('status'), 16) || 'pending';
  if (!['all', 'pending', 'approved', 'rejected', 'deleted'].includes(status)) {
    throw new HttpError(400, '讨论状态无效');
  }
  const limit = clampInt(url.searchParams.get('limit'), 80, 1, 200);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000);
  const [count, rows] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM comments WHERE (?='all' OR status=?)")
      .bind(status, status).first<{ count: number }>(),
    env.DB.prepare(`SELECT c.id,c.parent_id,c.document_id,c.embedded_item_id,c.paragraph_id,c.author_name,
      c.author_kind,c.body,c.status,c.moderation_note,c.created_at,c.updated_at,d.title AS document_title
      FROM comments c LEFT JOIN documents d ON d.id=c.document_id
      WHERE (?='all' OR c.status=?) ORDER BY c.created_at DESC,c.id DESC LIMIT ? OFFSET ?`)
      .bind(status, status, limit, offset).all(),
  ]);
  return json({ status, total: Number(count?.count || 0), limit, offset, rows: rows.results });
}

export async function adminReports(url: URL, env: Env, session: Session): Promise<Response> {
  requireAdmin(session);
  const status = textParam(url.searchParams.get('status'), 16) || 'open';
  if (!['all', 'open', 'resolved', 'dismissed'].includes(status)) throw new HttpError(400, '举报状态无效');
  const limit = clampInt(url.searchParams.get('limit'), 80, 1, 200);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000);
  const [count, rows] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM comment_reports WHERE (?='all' OR status=?)")
      .bind(status, status).first<{ count: number }>(),
    env.DB.prepare(`SELECT r.id,r.comment_id,r.reason,r.status,r.created_at,
      c.document_id,c.author_name,c.body AS comment_body,c.status AS comment_status,d.title AS document_title
      FROM comment_reports r JOIN comments c ON c.id=r.comment_id
      LEFT JOIN documents d ON d.id=c.document_id
      WHERE (?='all' OR r.status=?) ORDER BY r.created_at DESC,r.id DESC LIMIT ? OFFSET ?`)
      .bind(status, status, limit, offset).all(),
  ]);
  return json({ status, total: Number(count?.count || 0), limit, offset, rows: rows.results });
}

export async function adminAiLogs(url: URL, env: Env, session: Session): Promise<Response> {
  requireAdmin(session);
  const status = textParam(url.searchParams.get('status'), 16) || 'failed';
  if (!['all', 'ok', 'failed'].includes(status)) throw new HttpError(400, 'AI 审计状态无效');
  const limit = clampInt(url.searchParams.get('limit'), 80, 1, 200);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000);
  const condition = status === 'all' ? '1=1' : status === 'ok' ? "status='ok'" : "status!='ok'";
  const [count, result] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM ai_citation_logs WHERE ${condition}`)
      .first<{ count: number }>(),
    env.DB.prepare(`SELECT id,subject_filter,retrieved_paragraph_ids,cited_paragraph_ids,model_label,status,created_at
      FROM ai_citation_logs WHERE ${condition} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
      .bind(limit, offset).all<Record<string, unknown>>(),
  ]);
  const rows = result.results.map((row) => ({
    id: row.id,
    subject_filter: row.subject_filter,
    model_label: row.model_label,
    status: row.status,
    created_at: row.created_at,
    retrieved_count: safeArrayCount(row.retrieved_paragraph_ids),
    cited_count: safeArrayCount(row.cited_paragraph_ids),
  }));
  return json({ status, total: Number(count?.count || 0), limit, offset, rows });
}

export async function adminAudit(url: URL, env: Env, session: Session): Promise<Response> {
  requireAdmin(session);
  const entityType = textParam(url.searchParams.get('entityType'), 40);
  const action = textParam(url.searchParams.get('action'), 40);
  const limit = clampInt(url.searchParams.get('limit'), 80, 1, 200);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000);
  const [count, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM content_audit_log
      WHERE (?='' OR entity_type=?) AND (?='' OR action=?)`)
      .bind(entityType, entityType, action, action).first<{ count: number }>(),
    env.DB.prepare(`SELECT id,actor_slug,action,entity_type,entity_id,before_json,after_json,created_at
      FROM content_audit_log WHERE (?='' OR entity_type=?) AND (?='' OR action=?)
      ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
      .bind(entityType, entityType, action, action, limit, offset).all(),
  ]);
  return json({ entityType, action, total: Number(count?.count || 0), limit, offset, rows: rows.results });
}

interface ResolveReportInput {
  status?: string;
  note?: string;
  commentStatus?: string;
}

export async function resolveAdminReport(
  request: Request,
  env: Env,
  session: Session,
  id: string,
): Promise<Response> {
  requireSameOrigin(request, env);
  const actor = requireAdmin(session);
  const input = await readJson<ResolveReportInput>(request);
  const status = textParam(input.status || '', 16);
  const note = textParam(input.note || '', 240);
  const commentStatus = textParam(input.commentStatus || '', 16);
  if (!['resolved', 'dismissed'].includes(status)) throw new HttpError(400, '举报处理状态无效');
  if (note.length < 4) throw new HttpError(400, '请记录至少 4 个字符的处理理由');
  if (commentStatus && !['approved', 'rejected', 'deleted'].includes(commentStatus)) {
    throw new HttpError(400, '讨论处理状态无效');
  }
  const before = await env.DB.prepare(`SELECT r.id,r.comment_id,r.status AS report_status,c.status AS comment_status
    FROM comment_reports r JOIN comments c ON c.id=r.comment_id WHERE r.id=?`).bind(id)
    .first<{ id: string; comment_id: string; report_status: string; comment_status: string }>();
  if (!before) throw new HttpError(404, '举报不存在');
  if (before.report_status !== 'open') throw new HttpError(409, '该举报已处理');
  const nextCommentStatus = commentStatus || before.comment_status;
  const after = { report_status: status, comment_status: nextCommentStatus, note };
  const claim = `resolving:${crypto.randomUUID()}`;
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE comment_reports SET status=? WHERE id=? AND status='open'").bind(claim, id),
    env.DB.prepare(`UPDATE comments SET status=?,moderation_note=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND EXISTS(SELECT 1 FROM comment_reports WHERE id=? AND status=?)`)
      .bind(nextCommentStatus, note, before.comment_id, id, claim),
    env.DB.prepare(`INSERT INTO content_audit_log(id,actor_slug,action,entity_type,entity_id,before_json,after_json)
      SELECT ?,?,?,?,?,?,? FROM comment_reports WHERE id=? AND status=?`).bind(
      crypto.randomUUID(), actor.slug, 'resolve_report', 'comment_report', id,
      JSON.stringify({ report_status: before.report_status, comment_status: before.comment_status }),
      JSON.stringify(after),
      id, claim,
    ),
    env.DB.prepare('UPDATE comment_reports SET status=? WHERE id=? AND status=?').bind(status, id, claim),
  ]);
  const changes = results.map((result) => Number(
    (result as { meta?: { changes?: number } })?.meta?.changes,
  ));
  if (changes.length !== 4 || changes.some((value) => value !== 1)) {
    throw new HttpError(409, '该举报已由另一位管理员处理或审计事务未完整落盘');
  }
  return json({ ok: true, id, ...after });
}
