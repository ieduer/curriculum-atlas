import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../', import.meta.url);
const ledgerUrl = new URL('docs/project-operations-ledger.md', projectRoot);
const actionLogUrl = new URL('../reports/agent_action_log.jsonl', projectRoot);

test('operations ledger exposes the complete lifecycle and fail-closed status layers', async () => {
  const ledger = await readFile(ledgerUrl, 'utf8');
  for (const heading of [
    '# Curriculum Atlas 项目运维总账',
    '## 生成时本地事实',
    '## 最后一次外部核验快照',
    '## 生命周期里程碑',
    '## Git 提交时间线',
    '## 任务索引',
    '## 截止点内完整 append-only 运维事件',
    '## 发布与回滚硬规则',
  ]) assert.ok(ledger.includes(heading), heading);

  assert.match(ledger, /名义 86 docs \/ 11847 pages；唯一实体 85 docs \/ 11779 pages/u);
  assert.match(ledger, /OCR publication \| 0 accepted documents \/ 0 accepted pages/u);
  assert.match(ledger, /Production Worker[\s\S]+2026\.07\.15-v7/u);
  assert.match(ledger, /Preview Worker[\s\S]+2026\.07\.15-v8/u);
});

test('operations ledger binds an exact append-only prefix while allowing later events', async (t) => {
  try {
    await access(actionLogUrl);
  } catch {
    t.skip('workspace action log is not present in a standalone public clone');
    return;
  }

  const [ledger, raw] = await Promise.all([
    readFile(ledgerUrl, 'utf8'),
    readFile(actionLogUrl, 'utf8'),
  ]);
  const snapshotMatch = ledger.match(/<!-- curriculum-operations-ledger-snapshot (\{[^\n]+\}) -->/u);
  assert.ok(snapshotMatch, 'machine-readable ledger snapshot');
  const snapshot = JSON.parse(snapshotMatch[1]);
  assert.equal(snapshot.schema_version, 1);

  const allLines = raw.split(/\r?\n/u).filter(Boolean);
  assert.ok(snapshot.action_log_line_cutoff <= allLines.length, 'snapshot cutoff cannot exceed append-only log');
  const prefixLines = allLines.slice(0, snapshot.action_log_line_cutoff);
  const prefixDigest = createHash('sha256').update(`${prefixLines.join('\n')}\n`).digest('hex');
  assert.equal(prefixDigest, snapshot.action_log_prefix_sha256, 'append-only prefix must remain byte-identical');

  const entries = prefixLines.map(JSON.parse)
    .filter((entry) => /^curriculum(?:-|$)|curriculum-atlas/i.test(String(entry.task || '')));
  const header = ledger.match(/共 `(\d+)` 个任务、`(\d+)` 条运维事件/u);
  assert.ok(header, 'ledger count header');
  assert.equal(Number(header[2]), entries.length, 'ledger event count must match its frozen prefix');
  assert.equal(Number(header[2]), snapshot.included_event_count);
  const eventDigest = createHash('sha256')
    .update(entries.sort((left, right) => left.timestamp.localeCompare(right.timestamp)).map((entry) => JSON.stringify(entry)).join('\n'))
    .digest('hex');
  assert.equal(eventDigest, snapshot.included_event_sha256, 'curriculum event subset hash');
  for (const entry of entries) {
    assert.ok(ledger.includes(`### ${entry.timestamp} · ${entry.phase} · ${entry.agent}`), `${entry.timestamp} ${entry.task}`);
  }
});
