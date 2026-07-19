export async function loadAllParagraphPages(fetchPage, path, { pageSize = 200 } = {}) {
  let cursor = null;
  let first = null;
  let total = null;
  const paragraphs = [];
  const seen = new Set();
  for (let page = 0; page < 10_000; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const data = await fetchPage(`${path}${separator}limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const pageTotal = Number(data.total);
    if (!Number.isSafeInteger(pageTotal) || pageTotal < 0 || !Array.isArray(data.paragraphs)) {
      throw new Error('正文分页响应不完整');
    }
    if (first === null) {
      first = data;
      total = pageTotal;
    } else if (pageTotal !== total
      || String(data.document?.id || data.item?.id || '') !== String(first.document?.id || first.item?.id || '')) {
      throw new Error('正文分页期间资料身份发生变化');
    }
    for (const paragraph of data.paragraphs) {
      const id = String(paragraph.id || '');
      if (!id || seen.has(id)) throw new Error('正文分页出现重复或无效段落');
      seen.add(id);
      paragraphs.push(paragraph);
    }
    if (!data.hasMore) {
      if (paragraphs.length !== total || data.cursor !== null) throw new Error('正文分页总数不一致');
      return { ...first, paragraphs, total, hasMore: false, cursor: null, paragraph_cursor: null };
    }
    if (typeof data.cursor !== 'string' || !data.cursor || data.cursor === cursor) {
      throw new Error('正文分页游标没有前进');
    }
    cursor = data.cursor;
  }
  throw new Error('正文分页超过安全上限');
}

export async function loadAllCommentPages(fetchPage, path, { pageSize = 200 } = {}) {
  let cursor = null;
  let total = null;
  const comments = new Map();
  const pageIds = new Set();
  for (let page = 0; page < 10_000; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const data = await fetchPage(`${path}${separator}limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const pageTotal = Number(data.total);
    if (!Number.isSafeInteger(pageTotal) || pageTotal < 0
      || !Array.isArray(data.comments) || !Array.isArray(data.pageCommentIds)) {
      throw new Error('讨论分页响应不完整');
    }
    if (total === null) total = pageTotal;
    else if (total !== pageTotal) throw new Error('讨论分页期间筛选身份发生变化');
    for (const id of data.pageCommentIds) {
      if (!id || pageIds.has(id)) throw new Error('讨论分页出现重复或无效记录');
      pageIds.add(id);
    }
    for (const comment of data.comments) {
      const id = String(comment.id || '');
      if (!id) throw new Error('讨论分页出现无效父链记录');
      const prior = comments.get(id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(comment)) throw new Error('讨论父链在分页期间发生变化');
      comments.set(id, comment);
    }
    if (!data.hasMore) {
      if (pageIds.size !== total || data.cursor !== null) throw new Error('讨论分页总数不一致');
      return { comments: [...comments.values()], total, hasMore: false, cursor: null, comment_cursor: null };
    }
    if (typeof data.cursor !== 'string' || !data.cursor || data.cursor === cursor) {
      throw new Error('讨论分页游标没有前进');
    }
    cursor = data.cursor;
  }
  throw new Error('讨论分页超过安全上限');
}
