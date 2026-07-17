# 部署、验证与回滚

当前 preview 和 production 都被 release policy 阻断：两端 D1 只到 `0004`，Worker 仍是 `stable_keys_v0`。本文件描述解除阻断后的标准流程，不代表这些步骤已执行。

## 目标资源

| 环境 | Worker | D1 | R2 | 域名 |
|---|---|---|---|---|
| preview | `bdfz-curriculum-atlas-preview` | `bdfz-curriculum-atlas-preview` | `bdfz-curriculum-atlas-sources-preview` | workers.dev preview |
| production | `bdfz-curriculum-atlas` | `bdfz-curriculum-atlas` | `bdfz-curriculum-atlas-sources` | `curriculum.bdfz.net` |

## 发布合同

一次 release 必须同时绑定：

- 干净 Git commit 与完整 source-tree hash；
- `data/artifact-registry.json` 及通过的项目资产审计；
- catalog、ingest、OCR queue、page/semantic/online verification 资产；
- corpus release manifest、91 个 SQL chunk hash/bytes 与 D1 receipts；
- core/academic concept graph 同一 build revision；
- `public` 与 `dist` 的逐文件 hash/bytes parity；
- D1 migrations、Worker versioned R2 reader，以及由采集器生成、命令回执绑定的 `data/release-environment-evidence.json`。

缺任一项时，`npm run release:manifest` 或 publisher 必须在远端 mutation 前失败。

## 0. 冻结与本地验证

不得从 dirty tree 发布。先确认本任务拥有的文件、保存当前 diff/commit，再执行：

```bash
cd /Users/ylsuen/CF/curriculum-atlas
npm ci
npm run verify
npx wrangler whoami
git status --short
```

`npm run verify` 会依次重建 catalog、资产审计、corpus、概念图、在线核对、静态资产、类型、测试、release manifest 与 Worker dry-run。

## 1. 只读环境快照与回滚锚点

以下先对 preview 执行；生产窗口使用 production 资源名重复：

```bash
npx wrangler deployments list --name bdfz-curriculum-atlas-preview
npx wrangler d1 migrations list bdfz-curriculum-atlas-preview --env preview --remote
npx wrangler d1 time-travel info bdfz-curriculum-atlas-preview --env preview --timestamp <RFC3339_NOW> --json
npx wrangler r2 object get bdfz-curriculum-atlas-sources-preview/release/current.json --pipe --remote
```

若 R2 pointer 尚不存在，明确记录 bootstrap 状态；不要把 404 当作已备份。已有 pointer 时，把原始 bytes、SHA-256、release ID 与 manifest key 保存到任务私有回滚目录，禁止复制到公开日志。

## 2. 应用 0005、0006

```bash
npx wrangler d1 migrations apply bdfz-curriculum-atlas-preview --env preview --remote
npx wrangler d1 migrations list bdfz-curriculum-atlas-preview --env preview --remote
```

应用后只读核对：

- `page_publication_gates` 存在；
- `corpus_import_releases`、`corpus_import_chunks`、`corpus_import_guards` 存在；
- `current_corpus_release_id=legacy-bootstrap-0006`；
- bootstrap release 为 `ready`，expected/actual/live 计数一致；
- 既有评论、核验和段落行数没有意外减少。

## 3. 先部署支持 release gate 的 Worker

```bash
npm run deploy:preview
```

此时 R2 若还没有 pointer，`/api/source-manifest` 只允许 bootstrap fallback 到旧 stable key。先验证：

```bash
curl -fsS https://bdfz-curriculum-atlas-preview.bdfz.workers.dev/api/health
curl -fsS https://bdfz-curriculum-atlas-preview.bdfz.workers.dev/api/source-manifest
```

health 必须证明 bootstrap corpus ready、196/160/16/20/0 分类完整和五项 binding 存在。若失败，立即回滚 Worker；不要开始 corpus import。

## 4. 导入 corpus release

```bash
npm run corpus:build
npm run corpus:import:preview
```

导入语义：

- start 写 `in_progress`；新版 Worker 的 D1 业务 API 预期返回 503；
- 每个 SQL chunk 先验 hash/bytes，成功后单独写 receipt；
- 失败写 `failed` 并停止；恢复必须从报告的 `--from <NNN>` 精确位置执行，不能跳过 receipt；
- 只有全量 finalize 通过才写 `ready`。

导入后检查 health 中 release ID、manifest SHA、expected/live counts、accepted OCR documents 和 chunks 全部一致。

## 5. 更新环境证据并发布 R2

用采集器从 Wrangler、线上 health 与五个实时静态资产生成 preview 环境证据。不得手改 policy 或 receipt 绕过 blocker：

```bash
npm run release:evidence:preview
git add data/release-environment-evidence.json
git commit -m "chore: bind curriculum preview release evidence"
git push
npm run verify
```

采集结果必须绑定唯一 100% Worker version/deployment、精确 Git commit 的五项 byte parity、D1 migration 列表、health Git provenance、corpus release ID/fingerprint/manifest/counts 和 R2 pointer 状态；receipt 超过四小时自动失效。证据 commit 只更新发布回执时，Worker 资产可以仍对应其已验证的祖先 commit，但该 commit 必须存在且五项在线资产逐字节相等。

首次建立 pointer：

```bash
node scripts/publish-metadata.mjs \
  --bucket bdfz-curriculum-atlas-sources-preview \
  --environment preview \
  --bootstrap \
  --remote
```

后续版本：

```bash
npm run metadata:publish:preview
```

发布器只按以下顺序写：

1. 17 个 `releases/<release_id>/...` 不可变对象；
2. 每个对象 hash/bytes readback；
3. versioned `manifest.json` 与 readback；
4. 唯一可变写入 `release/current.json`；
5. pointer readback。

中途失败不得触碰旧 pointer。

## 6. Preview 验收

```bash
curl -fsS https://bdfz-curriculum-atlas-preview.bdfz.workers.dev/api/health
curl -fsS https://bdfz-curriculum-atlas-preview.bdfz.workers.dev/api/meta
curl -fsS 'https://bdfz-curriculum-atlas-preview.bdfz.workers.dev/api/search?q=核心素养'
curl -fsS 'https://bdfz-curriculum-atlas-preview.bdfz.workers.dev/api/documents/legacy-compendium-chinese?v=<CACHE_BUST>'
curl -fsS https://bdfz-curriculum-atlas-preview.bdfz.workers.dev/api/source-manifest
```

还必须完成真实桌面/移动浏览器：星图、单学科隔离、年代、概念深挖、版本资料、AI、教师讨论、刷新和深链接。然后回归 User Center、Nav、Portal、Companion 与 Pulse。浏览器会话完成后按工作区规则关闭并运行 Playwright orphan dry-run。

## 7. Production

Preview 所有证据通过后，重新冻结 production 专用 release 与回滚锚点，再按相同顺序执行：

```bash
npx wrangler d1 migrations apply bdfz-curriculum-atlas --remote
npm run deploy:production
npm run corpus:import:production
```

部署、导入并核实 production 后执行 `npm run release:evidence:production`，只提交该采集器生成的 receipt，推送并再次 `npm run verify`。首次 pointer 使用显式 `--bootstrap`；后续使用：

```bash
npm run metadata:publish:production
```

生产 smoke：

```bash
curl -fsS https://curriculum.bdfz.net/api/health
curl -fsS https://curriculum.bdfz.net/api/meta
curl -fsS 'https://curriculum.bdfz.net/api/search?q=核心素养'
curl -fsS 'https://curriculum.bdfz.net/api/documents/legacy-compendium-chinese?v=<CACHE_BUST>'
curl -fsS https://curriculum.bdfz.net/api/source-manifest
```

生产必须配置 `HASH_SALT` 与 `TURNSTILE_SECRET` Worker secrets；Turnstile public sitekey 在 `wrangler.jsonc`。任何 secret、cookie、session 或原始用户内容都不能进入报告。

## 回滚

### Worker

从部署前记录选择旧版本并按 Wrangler 当前版本命令回滚；完成后重复 health、meta、source-manifest 与浏览器 smoke。

### D1

只在确认影响范围后，以发布前 bookmark 执行：

```bash
npx wrangler d1 time-travel restore <DATABASE> --bookmark <BOOKMARK> --env <ENVIRONMENT> --json
```

恢复后重查 migrations、release state、documents/paragraphs/FTS/page gates/comments。

### R2

R2 回滚只把 `release/current.json` 恢复为已验证的旧 pointer bytes；不删除新旧不可变 release 对象。恢复 pointer 后必须重新读取 pointer、manifest 和目标 ingest object，核对 hash/bytes。

### 公共注册

只有产品被撤回时才同步处理 User Center、Nav、Portal、Companion 和 Pulse；普通代码/数据回滚不删除稳定 siteKey。

## 禁止事项

- 不在 migration 0005/0006 前部署 v9 数据路径。
- 不在旧 Worker 仍暴露混合数据时运行逐块 corpus import。
- 不手工覆盖 R2 stable JSON 或跳过 current pointer。
- 不从 dirty tree、未验证环境快照或 stale `dist` 发布。
- 不把 OCR complete、Vision complete、remote staging 或 local release 写成生产上线。
- 不使用 `INSERT OR REPLACE INTO documents` 破坏评论外键。
- 不把扫描原件、完整受版权约束 OCR、秘密或用户内容放入公开 R2／Git／报告。
