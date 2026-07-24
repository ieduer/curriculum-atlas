import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../', import.meta.url);
const ledgerUrl = new URL('docs/project-operations-ledger.md', projectRoot);
const actionLogUrl = new URL('../reports/agent_action_log.jsonl', projectRoot);
const releaseEvidenceUrl = new URL('data/release-environment-evidence.json', projectRoot);
const ledgerBuilderUrl = new URL('scripts/build-project-operations-ledger.mjs', projectRoot);

test('operations ledger exposes the current staged-release lifecycle and fail-closed status layers', async () => {
  const [ledger, evidence] = await Promise.all([
    readFile(ledgerUrl, 'utf8'),
    readFile(releaseEvidenceUrl, 'utf8').then(JSON.parse),
  ]);
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
  assert.match(ledger, /OCR publication \| 26 accepted documents \/ 30 unique accepted pages \/ 44 paragraph candidates/u);
  assert.equal(evidence.environments.production.health.version, '2026.07.24-v18');
  assert.equal(evidence.environments.preview.health.version, '2026.07.24-v18');
  assert.deepEqual(evidence.environments.production.pending_migrations, []);
  assert.deepEqual(evidence.environments.preview.pending_migrations, []);
  assert.equal(evidence.environments.production.applied_migrations.at(-1), '0007_document_taxonomy_contract.sql');
  assert.equal(evidence.environments.preview.applied_migrations.at(-1), '0007_document_taxonomy_contract.sql');
  assert.ok(ledger.includes(evidence.environments.production.worker_version_id));
  assert.ok(ledger.includes(evidence.environments.preview.worker_version_id));
  assert.match(ledger, /corpus-1c4f6b41737380f3e71246dd/u);
  assert.match(ledger, /159 subject \+ 1 assessment subject \+ 16 course \+ 20 scope/u);
  assert.match(ledger, /release-cd9ec4a050cbabbede744192398ebfa7/u);
  assert.match(ledger, /machine disposition 6947\/6947；published unique pages 30/u);
  assert.match(ledger, /1259 of 3182/u);
  assert.match(ledger, /3304581750 bytes/u);
  assert.match(ledger, /Worker 10c8d648-26d7-4e26-bd99-61b80dd9e0cc/u);
  assert.match(ledger, /Merged single-Canvas graph \| 2415 episodes；core 553，century 1031，current detail 97，pre-2001 specialist 426，generic OCR 308；5 tiers \/ 55 families \/ 12 storage identities \/ 11 public facets \/ 1648 memberships/u);
});

test('operations ledger derives current environment facts instead of hardcoding legacy workers', async () => {
  const builder = await readFile(ledgerBuilderUrl, 'utf8');
  assert.match(builder, /readJson\('data\/release-environment-evidence\.json'\)/u);
  assert.match(builder, /productionEvidence\.worker_version_id/u);
  assert.match(builder, /previewEvidence\.worker_version_id/u);
  assert.match(builder, /productionEvidence\.applied_migrations/u);
  assert.match(builder, /releaseEvidenceCommit = git\('log'/u);
  assert.match(builder, /machineVerification\.counts\.machine_adjudicated_pages/u);
  assert.match(builder, /publicationReceipt\.counts\.paragraph_candidates/u);
  assert.match(builder, /17\(\?:\\\/17\| of 17\)/u);
  assert.match(builder, /entry\.timestamp > productionEvidence\.observed_at/u);
  assert.match(builder, /const productionBrowserEvent = latestEvent/u);
  assert.doesNotMatch(builder, /Production Worker \| `7d1766b2/u);
  assert.doesNotMatch(builder, /Preview Worker \| `2459045b/u);
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
