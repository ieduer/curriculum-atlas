import assert from 'node:assert/strict';
import test from 'node:test';

import { loadAllCommentPages, loadAllParagraphPages } from '../public/release-pagination.js';

function cursorOffset(url) {
  const cursor = new URL(url, 'https://curriculum.example').searchParams.get('cursor');
  return cursor ? Number(Buffer.from(cursor, 'base64url').toString('utf8')) : 0;
}

test('frontend exhausts every paragraph page exactly once', async () => {
  const source = Array.from({ length: 451 }, (_, index) => ({ id: index + 1, body: `p-${index + 1}` }));
  const requests = [];
  const result = await loadAllParagraphPages(async (url) => {
    requests.push(url);
    const parsed = new URL(url, 'https://curriculum.example');
    const limit = Number(parsed.searchParams.get('limit'));
    const offset = cursorOffset(url);
    const paragraphs = source.slice(offset, offset + limit);
    const next = offset + paragraphs.length;
    return {
      document: { id: 'doc-a' },
      paragraphs,
      total: source.length,
      hasMore: next < source.length,
      cursor: next < source.length ? Buffer.from(String(next)).toString('base64url') : null,
    };
  }, '/api/documents/doc-a');
  assert.deepEqual(result.paragraphs.map((item) => item.id), source.map((item) => item.id));
  assert.equal(result.total, 451);
  assert.equal(result.cursor, null);
  assert.equal(result.paragraph_cursor, null);
  assert.deepEqual(requests.map(cursorOffset), [0, 200, 400]);
});

test('frontend exhausts comment pages while retaining cross-page ancestor chains', async () => {
  const pageMembers = Array.from({ length: 401 }, (_, index) => ({
    id: `comment-${String(index + 1).padStart(3, '0')}`,
    parent_id: index === 400 ? 'root-ancestor' : null,
    body: `comment ${index + 1}`,
  }));
  const ancestor = { id: 'root-ancestor', parent_id: null, body: 'root' };
  const requests = [];
  const result = await loadAllCommentPages(async (url) => {
    requests.push(url);
    const parsed = new URL(url, 'https://curriculum.example');
    const limit = Number(parsed.searchParams.get('limit'));
    const offset = cursorOffset(url);
    const page = pageMembers.slice(offset, offset + limit);
    const comments = page.some((item) => item.parent_id === ancestor.id) ? [...page, ancestor] : page;
    const next = offset + page.length;
    return {
      comments,
      pageCommentIds: page.map((item) => item.id),
      total: pageMembers.length,
      hasMore: next < pageMembers.length,
      cursor: next < pageMembers.length ? Buffer.from(String(next)).toString('base64url') : null,
    };
  }, '/api/comments?documentId=doc-a');
  assert.equal(result.total, 401);
  assert.equal(result.comments.length, 402);
  assert.equal(result.comments.find((item) => item.id === 'comment-401').parent_id, ancestor.id);
  assert.deepEqual(result.comments.filter((item) => item.id === ancestor.id), [ancestor]);
  assert.deepEqual(requests.map(cursorOffset), [0, 200, 400]);
});

test('frontend fails closed on repeated cursors or drifting ancestor bytes', async (t) => {
  await t.test('cursor must advance', async () => {
    let call = 0;
    await assert.rejects(() => loadAllParagraphPages(async () => {
      call += 1;
      return {
        document: { id: 'doc-a' }, paragraphs: [{ id: call }], total: 3, hasMore: true, cursor: 'same',
      };
    }, '/api/documents/doc-a'), /游标没有前进/);
  });
  await t.test('ancestor bytes must remain stable', async () => {
    let call = 0;
    await assert.rejects(() => loadAllCommentPages(async () => {
      call += 1;
      return {
        comments: [
          { id: `child-${call}`, parent_id: 'root' },
          { id: 'root', parent_id: null, body: call === 1 ? 'stable' : 'drifted' },
        ],
        pageCommentIds: [`child-${call}`],
        total: 2,
        hasMore: call === 1,
        cursor: call === 1 ? 'next' : null,
      };
    }, '/api/comments?documentId=doc-a', { pageSize: 1 }), /父链在分页期间发生变化/);
  });
});
