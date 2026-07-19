export async function loadAllDocumentIdentities(fetchPage, { pageSize = 200 } = {}) {
  if (typeof fetchPage !== 'function' || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw new Error('资料分页参数无效');
  }
  const documents = [];
  const ids = new Set();
  const cursors = new Set();
  let cursor = null;
  let expectedTotal = null;
  for (;;) {
    const page = await fetchPage({ limit: pageSize, cursor });
    if (!page || !Array.isArray(page.documents) || !Number.isSafeInteger(page.total) || page.total < 0
      || typeof page.hasMore !== 'boolean') {
      throw new Error('资料分页响应无效');
    }
    if (expectedTotal === null) expectedTotal = page.total;
    if (page.total !== expectedTotal || documents.length + page.documents.length > expectedTotal) {
      throw new Error('资料分页总数在读取中漂移');
    }
    for (const item of page.documents) {
      if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) {
        throw new Error('资料分页含有无效或重复身份');
      }
      ids.add(item.id);
      documents.push(item);
    }
    if (!page.hasMore) {
      if (page.cursor !== null || documents.length !== expectedTotal) {
        throw new Error('资料分页未完整闭合');
      }
      return documents;
    }
    if (page.documents.length === 0 || typeof page.cursor !== 'string' || !page.cursor || cursors.has(page.cursor)) {
      throw new Error('资料分页游标没有前进');
    }
    cursors.add(page.cursor);
    cursor = page.cursor;
  }
}
