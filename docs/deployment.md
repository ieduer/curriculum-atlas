# 部署、验证与回滚

当前 preview 与 production 已完成 v10 taxonomy / corpus / versioned R2 发布。本文同时记录当前线上锚点和下一次发布的标准流程；OCR 识别完成、远端 staging 或 Vision 完成不等于可发布正文。

## 当前线上锚点

| 环境 | Worker / deployment | Assets Git | D1 | Corpus | R2 current |
|---|---|---|---|---|---|
| preview | `2d107d38-cf31-49b6-82b1-20b32a32e824` / `32b91e16-302a-4672-b55d-4e73bcedf54a` | `40cb114e410e5f2afc886732eb146707edf8477b` | `0001`–`0007` | `corpus-358471fcce862b2f0ae446fc` ready | `release-841a528f0086ce69f2f7a6f2d07c0999` |
| production | `28c7e6d4-1638-42bc-b371-bd8d24210b93` / `baa8a92f-ccc8-4972-b0ad-6d67876cdc84` | `57487dc95481391cbcd40e0be0c92ee2d1ed8fdf` | `0001`–`0007` | `corpus-358471fcce862b2f0ae446fc` ready | `release-9cb02f77c06ee0535e7981a22b312373` |

两端 health 合同均为 `2026.07.16-v10`、全局 schema 3、taxonomy schema 2、page publication schema 1。Environment evidence 的最终 Git 提交为 `290755749a0257ed720e7b2d26aa6b972c60aebb`；该 evidence 在 production R2 首次 bootstrap 之前采集，因此其中 production pointer absent、preview predecessor pointer 是带时间的采集快照。R2 的后续激活状态以 append-only post-activation readback 为准，不能用旧快照覆盖。

当前 corpus 精确计数为：196 documents、16,456 paragraphs、16,456 FTS rows、6,031 page publication gates、16,456 displayed paragraphs、0 accepted OCR documents、91 chunks。taxonomy 为 159 subject、1 assessment subject、16 curriculum course、20 scope，公开为 12 display facets 与 28 exact subject query identities。

## 目标资源

| 环境 | Worker | D1 | R2 | 域名 |
|---|---|---|---|---|
| preview | `bdfz-curriculum-atlas-preview` | `bdfz-curriculum-atlas-preview` | `bdfz-curriculum-atlas-sources-preview` | `https://bdfz-curriculum-atlas-preview.bdfz.workers.dev` |
| production | `bdfz-curriculum-atlas` | `bdfz-curriculum-atlas` | `bdfz-curriculum-atlas-sources` | `https://curriculum.bdfz.net` |

## 发布合同

一次 release 必须同时绑定：

- clean Git commit、完整 source-tree hash 与 `data/artifact-registry.json`；
- catalog、ingest、OCR queue、page/semantic/online verification 资产；
- corpus release manifest、91 个 SQL chunk hash/bytes 与逐块 D1 receipt；
- core/academic concept graph 同一 build revision；
- `public` 与 `dist` 逐文件 hash/bytes parity；
- D1 migration 列表、唯一 100% Worker version/deployment、五项线上静态资产与 health provenance；
- versioned R2 pointer、manifest 和 17 个不可变对象的逐对象 GET hash/bytes readback。

缺任一项时，`npm run release:manifest`、corpus finalizer 或 metadata publisher 必须在暴露混合数据前 fail closed。

## 下一次标准发布流程

### 本地 `0008` / 篇目层的集成边界（尚未上线）

本分支只完成可独立审查的篇目数据合同、引文真值、稳定 ID、墓碑、分页、回复与深链接；它没有执行 D1/R2/Worker mutation，也没有切 current pointer。61 个候选仍是 0 display / 0 citation / 0 semantic。`0008_compendium_embedded_items.sql` 在 preview/production 都仍 pending。

篇目 release 必须与 page-evidence publication coordinator 的 fenced staging/CAS 机制集成后才可发布。当前只读集成锚点是 commit `5b056d8a516cfc6bd4714b243ce90981ec7f3904`；不得盲目复制该分支实现，也不得把本分支的 prepare gate 当成完整 coordinator。合并前要独立复核冲突、D1 fence、R2 content-addressed readback 和 compare-and-swap 激活语义。

规范状态机如下：

1. **prepare/bootstrap**：source gate 通过；环境 evidence 新鲜；当前旧 Worker/旧 corpus health 为 200/ready；pending migrations 精确且只能是声明的 `0008`；另有 `dual_schema_bootstrap_verified=true` 的可审计证据。Graph parity、目标 corpus mismatch 和声明 migration 在此阶段是预期后置条件，其他 blocker 不豁免。
2. **migration**：保存 D1 Time Travel 与用户表摘要后只应用声明 migration，回读 applied/pending 与 schema meta。没有 dual-schema 证据不得先部署本分支 Worker；没有回滚锚点不得迁移。
3. **stage corpus**：导入 successor、逐 chunk 回执并 finalize ready，但 staging 不写 current corpus pointer；旧 release 继续服务。
4. **stage graph/R2**：上传 content-addressed graph shards/manifest，逐对象 GET 校验 hash/bytes；仍不改 `release/current.json`。
5. **activate CAS**：以预读 current identity/fence 做 compare-and-swap，同时只激活已 ready 的 D1 corpus 与已读回的 R2 manifest；冲突即中止，不覆盖其他发布者。
6. **steady/postflight**：重新采集 environment evidence，要求 pending=0、目标 corpus 与本地 manifest 一致、Worker/graph Git parity、R2 current/manifest/object readback 全部一致，再运行 `--phase steady` 与浏览器/依赖回归。

`scripts/deploy-worker.mjs --phase prepare` 只是 bootstrap deployment gate：它允许的 blocker 白名单不等于发布成功，并强制 `dual_schema_bootstrap_verified=true`。当前 manifest 尚不产生这项证据，因此本分支单独运行 prepare 会 fail closed；这是明确的集成依赖，不是可绕过的错误。默认 `--phase steady` 继续要求所有后置状态已满足，不再把 postcondition 伪装成 migration 前置条件。

### 0. 所有权、冻结和本地验证

先核对 `git status` 与 `reports/agent_action_log.jsonl` 的文件/资源所有权，写 action-log `start`，再执行：

```bash
cd /Users/ylsuen/CF/curriculum-atlas
npm ci
npm run verify
npx wrangler whoami
git status --short
```

测试数量会随 OCR、release fencing 与篇目负例增加；每次发布记录当次 `npm run verify` 的实际通过数与命令回执，不复制旧基线数字。

### 1. 只读回滚锚点

Preview 先行；production 使用对应资源名重复：

```bash
npx wrangler deployments status --name bdfz-curriculum-atlas-preview --json
npx wrangler d1 migrations list bdfz-curriculum-atlas-preview --env preview --remote
npx wrangler d1 time-travel info bdfz-curriculum-atlas-preview --env preview --timestamp <RFC3339_NOW> --json
npx wrangler r2 object get bdfz-curriculum-atlas-sources-preview/release/current.json --pipe --remote
```

保存 Worker version/deployment、D1 Time Travel bookmark、评论/举报/限流/AI 审计基线，以及 R2 pointer 原始 bytes/SHA/release ID。404 只能记录为 pointer absent，不能伪装成已备份。

### 2. Migration 与兼容 Worker

无新 schema 时沿用下列常规顺序。有 `0008` 篇目层时必须使用上一节 fenced 状态机；下列命令不能绕过 dual-schema/bootstrap、stage-no-pointer 或 CAS 激活条件：

```bash
npx wrangler d1 migrations apply bdfz-curriculum-atlas-preview --env preview --remote
npx wrangler d1 migrations list bdfz-curriculum-atlas-preview --env preview --remote
npm run deploy:preview
```

Worker 必须能读取迁移后的 schema，并在 corpus 非 `ready` 时返回 503。不要让旧 Worker 与新 D1 schema 长时间组合；历史 v7 不能读取 taxonomy schema 2。

### 3. Corpus import

```bash
npm run corpus:build
npm run corpus:import:preview
```

- importer 先写 `in_progress`，每个 chunk 成功后单独写 name/hash/bytes receipt；
- 客户端中断时先查询远端 receipts，只从第一个未提交的精确 chunk 恢复；
- 不盲目重放，不跳过 receipt，不把部分导入写成 ready；
- finalize 只在 196/16,456/16,456/6,031/16,456/0/91 等 manifest 计数全部相等时写 `ready`。

恢复参数以 importer 输出的首个未提交编号为准：

```bash
npm run corpus:import:preview -- --from <NNN>
```

### 4. Git-bound environment evidence

```bash
npm run release:evidence:preview -- --asset-commit <ASSET_COMMIT>
git add data/release-environment-evidence.json
git commit -m "chore: bind curriculum preview release evidence"
git push
npm run verify
```

Evidence 必须来自命令回执，不手改字段绕过 policy。采集后若 D1、Worker、Assets 或 corpus 发生变化，重新采集。

### 5. Versioned R2 发布

```bash
npm run metadata:publish:preview
```

发布器顺序固定：17 个不可变对象 → 每对象 readback → versioned manifest/readback → 唯一可变 `release/current.json` → pointer readback。中断时：

1. 先读取 current pointer、目标 manifest 与对象列表；
2. 若 pointer 未切换，旧 release 仍在线，新不可变对象可安全保持未引用；
3. 若 pointer 已切换，完成全量 readback 后再决定是否回滚；
4. 不盲目重跑。相同 release ID 的 immutable key 可能已经存在，publisher 的拒绝是保护，不是要求覆盖。

Production 已完成首次 `--bootstrap`，后续不得再次假定 pointer absent；正常使用 `npm run metadata:publish:production`。

### 6. Preview 验收后提升 production

```bash
curl -fsS https://bdfz-curriculum-atlas-preview.bdfz.workers.dev/api/health
curl -fsS https://bdfz-curriculum-atlas-preview.bdfz.workers.dev/api/meta
curl -fsS 'https://bdfz-curriculum-atlas-preview.bdfz.workers.dev/api/search?q=核心素养'
curl -fsS https://bdfz-curriculum-atlas-preview.bdfz.workers.dev/api/source-manifest
```

完成 desktop/mobile 星图、全隐藏、单科自动适配、语文深挖、年代、资料/版本、AI/讨论、刷新和深链接；再回归 User Center、Nav、Portal、Companion、APIS 与 Pulse。关闭任务浏览器并执行 Playwright orphan dry-run。

Production 重复同一链路：migration → compatible Worker → exact corpus import → evidence commit/push → verify → R2 release → API/browser/dependency QA。

## 当前 production R2 独立读回

- release：`release-9cb02f77c06ee0535e7981a22b312373`；
- pointer：388 bytes，SHA-256 `5142166d000fbf82e6d0a9d135a5340ba3c9d77f3bed803967ad565ff8c2133a`；
- manifest：107,777 bytes，SHA-256 `a6a15ea83cc58b1b84f5587a110c0fddeb414f24c77ff534507ea96868c03964`；
- 17/17 unique release objects：546,648 bytes，manifest、远端 GET、本地来源三方逐字节一致；
- `/api/source-manifest`：55,183 bytes，SHA-256 `0f0fda279b10ef40011ea28477deb528ed5d45b7478dfd93a8b7bf6d0b1cb16e`。

## 当前 production API / 浏览器 / D1 / Pulse 终验

权威 append-only `verify` 事件为 `2026-07-17T06:35:37.437Z`，只读验收结果：

- `/api/health` 为 200，v10、Assets Git `57487dc`、schema 3 / taxonomy 2 / page publication 1，D1、R2、APIS、User Center、Assets 五项 binding 均存在；corpus 为 196 documents / 16,456 paragraphs / 16,456 FTS / 6,031 gates / 91 chunks，taxonomy 为 159 subject + 1 assessment subject + 16 course + 20 scope + 0 unclassified。
- 1440×1000、1280×720、390×844 均无 horizontal overflow；完整星图为 553 nodes / 214 lineage edges / 261 cross-subject edges，全隐藏为 0/0，语文为 143/60 且“运动能力”泄漏为 0。桌面语文单科自动缩放 0.864→1.32，移动端 0.20→0.568；深链接、刷新、资料/版本及 AI/讨论工作台、拖拽、缩放均通过。
- AI 未认证写入 401、非法 Origin 讨论写入 403；D1 验收前后 comments / reports / rate limits / AI citation logs / content audit logs 为 0/0/3/2/0，canonical digest 均为 `c4166f451f4b9529bf4221b56fb3017dc51aef7493a699553dc218287e42c430`。
- Pulse 为 425 requests / 0 errors。第一方 console/page errors 为 0；Turnstile challenge 产生 2 个第三方 opaque console errors 和 5 个 warnings，不计为第一方回归失败，但继续观察。
- 所有任务命名浏览器已关闭，CLI list 为空；root process 检查无任务 `cliDaemon.js` 或 Playwright profile，仅有 App-owned MCP。规定的 orphan dry-run 因平台 usage limit 拒绝提权，未绕过；因此这里只声明上述两项可验证的 teardown 证据，不声明 dry-run 已通过。

当前概念 observation 数据只到 2020。2022 corpus documents 与年代轨已上线，但不能据此宣称已有 2022 概念演变观察；须等 accepted OCR、版本核对与概念重建闭环后另行发布。

## 回滚

### Worker + D1 耦合回滚

Production prechange anchor：

- D1 bookmark：`0000002b-00002585-000050ab-8645885d977dc9bf5678e6cdf12b084f`；
- Worker v7：`7d1766b2-32be-4ce1-9528-f6c69bb2a092`；
- prechange deployment：`4f2042f6-ce2c-40c0-a7a0-06f48188726b`。

不能只把 Worker 回到 v7：v7 与 D1 taxonomy schema 2 不兼容，会 fail closed 503。只有确认 bookmark 之后没有需要保留的评论、举报、限流或 AI 审计写入，且 forward repair 不可行时，才在同一维护窗口耦合恢复 D1 与 Worker；之后重查 migrations、196 documents、16,456 paragraphs、FTS、page gates、用户数据表和 API/browser smoke。

```bash
npx wrangler d1 time-travel restore bdfz-curriculum-atlas \
  --bookmark 0000002b-00002585-000050ab-8645885d977dc9bf5678e6cdf12b084f \
  --json
```

Worker 回滚命令使用执行时 Wrangler 的 `versions deploy --help` 验证后的语法，并记录 message；不要在文档中伪造未执行的 deployment ID。

### R2-only 回滚

Production 是首次 versioned pointer：删除且只删除 `bdfz-curriculum-atlas-sources/release/current.json` 可恢复 v10 的已验证 stable-key fallback。不要删除 `releases/release-9cb02f77c06ee0535e7981a22b312373/**`；未引用的不可变对象不影响线上。

Preview 有 predecessor pointer，应恢复备份的原始 pointer bytes，指回 `release-b1c8c31d00e0016ad885ae5c9e92cad1`；恢复后重新 GET pointer、manifest 和 ingest object 核对 hash/bytes。任何 R2-only 回滚不触碰 D1 或 Worker。

### 公共注册

普通代码/数据回滚不删除稳定 `siteKey`。只有产品撤回时，才作为一个事务同步 User Center、Nav、Portal、Companion 与 Pulse。

## 私有加密档案

本地索引：`backups/curriculum-atlas/private-archive/20260717T021000Z/archive-index.json`。远端精确前缀包含 14 个加密 parts 与最后上传的 index，共 15 objects / 3,304,581,750 bytes；完整 GET、逐 part SHA-256、decrypt、decompress 与 raw/evidence manifest replay 均通过。密钥不进入 Git、报告、命令或日志。删除该前缀属于独立破坏性动作，必须另行明确授权。

## 禁止事项

- 不从 dirty tree、stale `dist`、过期 environment evidence 或未 ready corpus 发布；
- 不把 OCR complete、Vision complete、远端 staging 或 B-r1 partial state写成可显示/可引文正文；
- 不在没有 hash-bound seed lineage 时把 B-r1 输出复制到新配置；
- 不手工覆盖 immutable R2 objects，不跳过 pointer/readback，不在中断后盲目重跑；
- 不使用 `INSERT OR REPLACE INTO documents` 破坏评论外键；
- 不把扫描原件、完整受版权约束 OCR、secret、cookie、session 或用户内容放入公开 R2、Git 或报告。
