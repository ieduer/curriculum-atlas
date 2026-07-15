import { HttpError } from './http';
import { hashPrivate, sha256 } from './security';
import { retrieve } from './retrieval';
import type { AiCitation, Env, Session } from './types';

function citedIds(answer: string): number[] {
  return [...answer.matchAll(/P:(\d+)/g)].map((match) => Number(match[1]));
}

export async function answerWithEvidence(
  env: Env,
  session: Session,
  query: string,
  subject: string,
): Promise<{ answer: string; citations: AiCitation[]; retrievalCount: number }> {
  const passages = await retrieve(env, { query, subject, limit: 10 });
  if (passages.length === 0) throw new HttpError(422, '资料库中没有找到足够证据，请调整关键词或取消学科筛选');
  const context = passages.map((passage) =>
    `[P:${passage.id}] ${passage.title}｜${passage.source_locator}\n${passage.body}`,
  ).join('\n\n');
  const prompt = `你是“中国历年课程标准与考试评价演变”教师研究助手。只使用下列检索证据回答。\n\n规则：\n1. 每个事实判断必须紧跟 [P:数字] 引文；只能使用提供的编号。\n2. 区分原文事实、跨版本比较和教学建议；教学建议明确标注“建议”。\n3. 证据不足时直说，不补写不存在的标准条文。\n4. 不把修订动态误报为已发布标准。\n5. 用简洁中文回答，末尾给出“证据边界”。\n\n教师问题：${query}\n${subject ? `学科筛选：${subject}\n` : ''}\n检索证据：\n${context}`;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: env.AI_ORIGIN,
      'X-Project-Name': 'curriculum-atlas',
      'X-Task-Type': 'chat',
      'X-Thinking-Level': 'medium',
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1500 },
    }),
  };
  const response = env.APIS
    ? await env.APIS.fetch(new Request('https://apis.internal/', init))
    : await fetch(env.AI_GATEWAY_URL || 'https://apis.bdfz.net/', init);
  const data = await response.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const answer = String(
    data.answer || data.reply || data.text ||
    (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '',
  ).trim();
  if (!response.ok || !answer) throw new HttpError(502, `共享 AI 网关暂不可用（${response.status}）`);

  const allowed = new Map(passages.map((passage) => [passage.id, passage]));
  const ids = [...new Set(citedIds(answer))];
  if (ids.length === 0 || ids.some((id) => !allowed.has(id))) {
    await logAi(env, session, query, subject, passages.map((item) => item.id), [], 'citation_validation_failed');
    throw new HttpError(502, 'AI 回答未通过引文校验，请重试或直接查看检索证据');
  }
  const citations = ids.map((id) => {
    const passage = allowed.get(id)!;
    return {
      paragraphId: passage.id,
      documentId: passage.document_id,
      title: passage.title,
      subject: passage.subject,
      locator: passage.source_locator,
      sourceUrl: passage.source_url,
      excerpt: passage.body.slice(0, 240),
    };
  });
  await logAi(env, session, query, subject, passages.map((item) => item.id), ids, 'ok');
  return { answer, citations, retrievalCount: passages.length };
}

async function logAi(env: Env, session: Session, query: string, subject: string, retrieved: number[], cited: number[], status: string) {
  const actorHash = session.user?.slug ? await hashPrivate(`user:${session.user.slug}`, env) : null;
  await env.DB.prepare(
    `INSERT INTO ai_citation_logs(id,actor_hash,query_hash,subject_filter,retrieved_paragraph_ids,cited_paragraph_ids,model_label,status)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).bind(
    crypto.randomUUID(), actorHash, await sha256(query), subject || null,
    JSON.stringify(retrieved), JSON.stringify(cited), env.AI_MODEL_LABEL, status,
  ).run();
}
