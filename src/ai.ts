import { HttpError } from './http';
import { hashPrivate, sha256 } from './security';
import { retrieve } from './retrieval';
import type { AiCitation, Env, Session } from './types';

const STRUCTURAL_HEADINGS = new Set([
  '原文事实',
  '跨版本比较',
  '教学建议',
  '建议',
  '证据边界',
  '结论',
  '回答',
  '要点',
  '分析',
  '说明',
  '依据',
  '资料范围',
]);

const FACTUAL_SUGGESTION_SIGNAL = new RegExp([
  '(?:18|19|20)\\d{2}年?',
  '(?:根据|依据|按照|依照|参照|按).{0,20}(?:课标|课程标准|教学大纲|标准|大纲|文件|版本|原文|资料|证据)',
  '(?:课标|课程标准|教学大纲|标准|大纲|文件|版本|原文|资料|证据).{0,20}(?:规定|要求|提出|强调|明确|指出|显示|表明|包括|分为|新增|删除|发布|实施|修订|废止|替代|调整|变化|转向)',
  '第\\s*\\d+\\s*页',
].join('|'));

export interface AiAnswerCitationValidation {
  valid: boolean;
  citedIds: number[];
  invalidCitationIds: number[];
  malformedCitations: string[];
  uncitedClaims: string[];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function splitSemanticUnits(line: string): string[] {
  const units: string[] = [];
  let start = 0;
  let index = 0;
  while (index < line.length) {
    const character = line[index];
    const decimalPoint = character === '.' && /\d/.test(line[index - 1] || '') && /\d/.test(line[index + 1] || '');
    if (!/[。！？!?；;.]/.test(character) || decimalPoint) {
      index += 1;
      continue;
    }
    let end = index + 1;
    let cursor = end;
    let foundCitation = false;
    do {
      while (cursor < line.length && /[ \t]/.test(line[cursor])) cursor += 1;
      const citation = line.slice(cursor).match(/^\[P:[^\]\r\n]*\]/);
      if (!citation) break;
      foundCitation = true;
      cursor += citation[0].length;
      end = cursor;
    } while (cursor < line.length);
    if (!foundCitation) end = index + 1;
    const unit = line.slice(start, end).trim();
    if (unit) units.push(unit);
    start = end;
    index = end;
  }
  const remainder = line.slice(start).trim();
  if (remainder) units.push(remainder);
  return units;
}

function isTableSeparator(value: string): boolean {
  const trimmed = value.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (!trimmed.includes('|')) return false;
  const cells = trimmed.split('|').map((cell) => cell.trim()).filter(Boolean);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function normalizeForClassification(value: string): string {
  let normalized = value.trim();
  normalized = normalized.replace(/^(?:>\s*)+/, '');
  normalized = normalized.replace(/^#{1,6}\s*/, '');
  normalized = normalized.replace(/^(?:[-+*]\s+|\d{1,3}[.)、]\s*)/, '');
  normalized = normalized.replace(/^(?:\*\*|__)/, '').replace(/(?:\*\*|__)$/, '');
  normalized = normalized.replace(/\[P:[^\]\r\n]*\]/g, '').trim();
  normalized = normalized.replace(/^(?:\*\*|__)/, '').replace(/(?:\*\*|__)$/, '').trim();
  return normalized;
}

function isExplicitUncertainty(value: string): boolean {
  const normalized = value.replace(/[。！？!?]+$/, '').trim();
  if (!normalized || /(?:但(?:是)?|然而|不过|却|而(?:且)?|并(?:且)?|事实上|实际上|与此同时|此外|另外|仍(?:然)?(?:明确|规定|要求|显示|表明|指出|存在|属于|包括))/.test(normalized)) return false;
  return [
    /^(?:现有|当前|上述|已有|检索所得)?(?:的)?(?:证据|资料|材料|信息|依据)(?:仍|尚)?(?:不足|有限|不充分)(?:[，,：:]\s*(?:因此|因而)?(?:暂时|目前|尚)?(?:无法|不能|不足以)(?:从(?:现有|当前|上述|已有)?(?:证据|资料|材料|信息|依据)中?)?(?:确认|判断|支持|说明|得出|回答|核实|断言)(?:[^，,；;。！？!?]+)?)?$/,
    /^(?:暂时|目前|尚)?(?:无法|不能)(?:从(?:现有|当前|上述|已有)?(?:证据|资料|材料|信息|依据)中?)?(?:确认|判断|支持|说明|得出|回答|核实|断言)(?:[^，,；;。！？!?]+)?$/,
    /^(?:在(?:现有|当前|上述|已有)?(?:证据|资料|材料|信息|依据)中)?(?:尚|仍|目前|暂时)?未(?:能)?找到(?:足够|可核验|直接|明确|相关)?(?:的)?(?:证据|资料|材料|信息|依据)(?:[^，,；;。！？!?]+)?$/,
  ].some((pattern) => pattern.test(normalized));
}

function isNonFactualUnit(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^(?:`{3,}|~{3,})/.test(trimmed)) return true;
  if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed) || isTableSeparator(trimmed)) return true;
  const normalized = normalizeForClassification(trimmed);
  if (!normalized) return true;
  if (STRUCTURAL_HEADINGS.has(normalized.replace(/[：:]$/, '').trim())) return true;
  if (isExplicitUncertainty(normalized)) return true;
  if (/^(?:教学建议|建议)/.test(normalized) && !FACTUAL_SUGGESTION_SIGNAL.test(normalized)) return true;
  return false;
}

export function validateAiAnswerCitations(
  answer: string,
  allowedIds: Iterable<number>,
): AiAnswerCitationValidation {
  const allowed = new Set([...allowedIds].map(Number));
  const citedIds = uniqueNumbers(
    [...answer.matchAll(/\[P:(\d+)\]/g)].map((match) => Number(match[1])),
  );
  const invalidCitationIds = citedIds.filter((id) => !allowed.has(id));
  const malformedCitations = [
    ...answer.matchAll(/\[P:([^\]\r\n]*)\]/g),
  ].filter((match) => !/^\d+$/.test(match[1])).map((match) => match[0]);
  const withoutClosedCitations = answer.replace(/\[P:[^\]\r\n]*\]/g, '');
  malformedCitations.push(
    ...[...withoutClosedCitations.matchAll(/\[P:[^\s\r\n]*/g)].map((match) => match[0]),
  );

  const uncitedClaims: string[] = [];
  for (const line of answer.split(/\r?\n/)) {
    for (const unit of splitSemanticUnits(line)) {
      if (isNonFactualUnit(unit)) continue;
      const hasAllowedCitation = [...unit.matchAll(/\[P:(\d+)\]/g)]
        .some((match) => allowed.has(Number(match[1])));
      if (!hasAllowedCitation) uncitedClaims.push(unit);
    }
  }

  return {
    valid: invalidCitationIds.length === 0 && malformedCitations.length === 0 && uncitedClaims.length === 0,
    citedIds,
    invalidCitationIds,
    malformedCitations: [...new Set(malformedCitations)],
    uncitedClaims,
  };
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
  const prompt = `你是“中国历年课程标准与考试评价演变”教师研究助手。只使用下列检索证据回答。\n\n规则：\n1. 每个事实句必须在同一句紧跟 [P:数字] 引文；只能使用提供的编号，不能让多句事实共用末尾的一个引文。\n2. 区分原文事实、跨版本比较和教学建议；教学建议明确以“建议”或“教学建议”开头。\n3. 只有不陈述标准事实的教学建议和明确的证据不足句可以不带引文。\n4. 证据不足时直说，不补写不存在的标准条文。\n5. 不把修订动态误报为已发布标准。\n6. 用简洁中文回答，末尾给出“证据边界”。\n\n教师问题：${query}\n${subject ? `学科筛选：${subject}\n` : ''}\n检索证据：\n${context}`;
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
  const validation = validateAiAnswerCitations(answer, allowed.keys());
  if (!validation.valid) {
    await logAi(env, session, query, subject, passages.map((item) => item.id), [], 'citation_validation_failed');
    throw new HttpError(502, 'AI 回答未通过引文校验，请重试或直接查看检索证据');
  }
  const ids = validation.citedIds;
  const citations = ids.map((id) => {
    const passage = allowed.get(id)!;
    return {
      paragraphId: passage.id,
      documentId: passage.document_id,
      title: passage.title,
      subject: passage.subject,
      entityLabel: passage.entity_label,
      entityKind: passage.entity_kind,
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
