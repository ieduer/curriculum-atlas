import assert from 'node:assert/strict';
import test from 'node:test';
import { ftsQuery } from '../src/search-query.ts';

test('Chinese research questions become punctuation-free overlapping terms', () => {
  const query = ftsQuery('2017年版高中思想政治课程标准如何评价核心素养？请只依据资料库回答。');
  assert.equal(query.includes('？'), false);
  assert.equal(query.includes('。'), false);
  assert.match(query, /"思想政治"/);
  assert.match(query, /"课程标准"/);
  assert.match(query, /"核心素养"/);
});

test('short explicit keywords remain exact FTS alternatives', () => {
  assert.equal(ftsQuery('核心素养 评价 建议'), '"核心素养" OR "评价" OR "建议"');
});
