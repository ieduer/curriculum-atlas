# 部署、验证与回滚

当前 preview 与 production 已完成 v10 taxonomy / corpus / versioned R2 发布。本文同时记录当前线上锚点和下一次发布的标准流程；OCR 识别完成、远端 staging 或 Vision 完成不等于可发布正文。

## 当前线上锚点

| 环境 | Worker / deployment | Assets Git | D1 | Corpus | R2 current |
|---|---|---|---|---|---|
| preview | `2d107d38-cf31-49b6-82b1-20b32a32e824` / `32b91e16-302a-4672-b55d-4e73bcedf54a` | `40cb114e410e5f2afc886732eb146707edf8477b` | `0001`–`0007` | `corpus-358471fcce862b2f0ae446fc` ready | `release-841a528f0086ce69f2f7a6f2d07c0999` |
| production | `28c7e6d4-1638-42bc-b371-bd8d24210b93` / `baa8a92f-ccc8-4972-b0ad-6d67876cdc84` | `57487dc95481391cbcd40e0be0c92ee2d1ed8fdf` | `0001`–`0007` | `corpus-358471fcce862b2f0ae446fc` ready | `release-9cb02f77c06ee0535e7981a22b312373` |

两端 health 合同均为 `2026.07.16-v10`、全局 schema 3、taxonomy schema 2、page publication schema 1。Environment evidence 的最终 Git 提交为 `290755749a0257ed720e7b2d26aa6b972c60aebb`；该 evidence 在 production R2 首次 bootstrap 之前采集，因此其中 production pointer absent、preview predecessor pointer 是带时间的采集快照。R2 的后续激活状态以 append-only post-activation readback 为准，不能用旧快照覆盖。

当前 corpus 精确计数为：196 documents、16,456 paragraphs、16,456 FTS rows、6,031 page publication gates、16,456 displayed paragraphs、0 accepted OCR documents、91 chunks。taxonomy 为 159 subject、1 assessment subject、16 curriculum course、20 scope，公开为 12 display facets 与 28 exact subject query identities。

以上是线上 legacy 锚点，不代表本仓库新增的 fenced publication v2 与篇目 schema 已上线。v2 首次发布必须先生成并校验 dual-schema receipt、部署兼容 `0001`–`0009` 的 bridge Worker，再按序应用 `0008_release_ownership_fences.sql` 与 `0009_compendium_embedded_items.sql`、安装协调器 secret，并通过下述完整流程；在这些步骤完成前不得把线上 `0001`–`0007` 或 schema-1 pointer 记作 v2 合格。

## 目标资源

| 环境 | Worker | D1 | R2 | 域名 |
|---|---|---|---|---|
| preview | `bdfz-curriculum-atlas-preview` | `bdfz-curriculum-atlas-preview` | `bdfz-curriculum-atlas-sources-preview` | `https://bdfz-curriculum-atlas-preview.bdfz.workers.dev` |
| production | `bdfz-curriculum-atlas` | `bdfz-curriculum-atlas` | `bdfz-curriculum-atlas-sources` | `https://curriculum.bdfz.net` |

## 发布合同

一次 release 只有一个 `curriculum_desired_release_v2` artifact；Worker、D1 corpus、R2 与 environment evidence 必须同时绑定它的 Git HEAD、release ID、manifest SHA-256/bytes、source-tree SHA-256 和 corpus pin。该 artifact 不含环境观测时间、pointer、health 或 evidence receipt 等可变状态。它还必须绑定：

- clean Git commit、完整 source-tree hash 与 `data/artifact-registry.json`；
- catalog、ingest、OCR queue、page/semantic/online verification 资产；
- corpus release manifest、完整 builder inputs / text assets / 91 个 SQL chunk 私有快照，以及逐块原子 D1 receipt；
- core/academic concept graph 同一 build revision；
- `public` 与 `dist` 逐文件 hash/bytes parity；
- D1 migration 列表（按序含 `0008`、`0009`）、唯一 100% Worker version/deployment、五项线上静态资产与 health provenance；
- corpus 与 publication 各自的 owner token、单调 fence、expiry takeover 和 prechange Time Travel receipt；
- importer 在第一次远端命令前把 live corpus envelope 与 SQL inventory 精确绑定到上述唯一 desired-release artifact；已经 `ready` 的同一 corpus release 只允许返回 `already_ready`，不得重写 release metadata、chunk receipts 或 current corpus metadata；
- 由 Worker R2 binding 协调的 immutable create、完整 prefix inventory、ETag 条件激活，以及 manifest 和当前 v3 coordination policy 中 16 个不可变对象的逐对象 GET hash/bytes/HTTP Content-Type/custom-metadata readback。

缺任一项时，`npm run release:manifest`、corpus finalizer 或 metadata publisher 必须在暴露混合数据前 fail closed。

## 下一次标准发布流程

### 本地 `0008` / `0009` 集成边界（尚未上线）

本分支已把篇目数据合同、引文真值、稳定 ID、墓碑、详情/篇目/讨论分页、精确回复作用域、dual-schema bootstrap 与 D1/R2 fenced coordinator 集成为一个可审查候选；它没有执行 D1/R2/Worker mutation，也没有切 current pointer。61 个候选仍是 0 display / 0 citation / 0 semantic。`0008_release_ownership_fences.sql` 与 `0009_compendium_embedded_items.sql` 在 preview/production 都仍 pending。

候选实现仍必须在合并与发布前独立复核 D1 fence、R2 content-addressed readback、失败时 predecessor 原字节恢复、compare-and-swap 激活语义及下一 fence 单调递增；不得把本地 prepare gate 或测试通过当成线上激活。

规范状态机如下：

1. **prepare/bootstrap**：source gate 通过；环境 evidence 新鲜；当前旧 Worker/旧 corpus health 为 200/ready；pending migrations 必须按序精确等于 `0008_release_ownership_fences.sql`、`0009_compendium_embedded_items.sql`；collector 执行 `scripts/verify-dual-schema-bootstrap.mjs`，把绑定 bridge source 与两份 migration 原字节的 `dual_schema_bootstrap_receipt` 传入 manifest，prepare gate 再按当前文件逐项验签。Graph parity、目标 corpus mismatch 和这两项声明 migration 在此阶段是预期后置条件，其他 blocker 不豁免。
2. **bridge / migration**：先以同一 desired-release artifact 部署同时兼容 legacy `0001`–`0007`、fenced `0008` 和 compendium `0009` 的 bridge Worker；保存 D1 Time Travel 与用户表摘要后，严格按 `0008` → `0009` 应用 migration，并回读 applied/pending 与 schema meta。没有可执行 receipt 不得部署 bridge；没有 bridge health 与回滚锚点不得迁移。
3. **stage corpus**：导入 successor、逐 chunk 回执并 finalize ready，但 staging 不写 current corpus pointer；旧 release 继续服务。
4. **stage graph/R2**：上传 content-addressed graph shards/manifest，逐对象 GET 校验 hash/bytes；仍不改 `release/current.json`。
5. **activate CAS**：以预读 current identity/fence 做 compare-and-swap，同时只激活已 ready 的 D1 corpus 与已读回的 R2 manifest；冲突即中止，不覆盖其他发布者。
6. **steady/postflight**：重新采集 environment evidence，要求 pending=0、目标 corpus 与本地 manifest 一致、Worker/graph Git parity、R2 current/manifest/object readback 全部一致，再运行 `--phase steady` 与浏览器/依赖回归。

`scripts/deploy-worker.mjs --phase prepare` 只是 bootstrap deployment gate：它允许的 blocker 白名单不等于发布成功。collector → manifest → prepare 必须传递并重新验证完整 `dual_schema_bootstrap_receipt`，不存在可手填的 boolean 捷径。默认 `--phase steady` 继续要求所有后置状态已满足，不把 postcondition 伪装成 migration 前置条件。

### 0. 所有权、冻结和本地验证

先核对 `git status` 与 `reports/agent_action_log.jsonl` 的文件/资源所有权，写 action-log `start`。完成全部生成与测试后提交、推送，最后从 clean 且 upstream-exact 的 HEAD 生成唯一 artifact：

```bash
cd /Users/ylsuen/CF/curriculum-atlas
npm ci
npm run page-evidence:validate
npm run catalog
npm run assets:audit
npm run corpus:build
npm run concepts:build
npm run concepts:validate
npm run build
npm run check
npm test
npm run test:python
git diff --check
git status --short
# 审核并提交实际变更，然后 push；不得用占位提交或跳过审阅
npm run verify
npx wrangler whoami
git status --short
sha256sum .wrangler/release-manifest.json
```

测试数量会随 OCR、release fencing 与篇目负例增加；每次发布记录当次 `npm run verify` 的实际通过数与命令回执，不复制旧基线数字。`npm run verify` 会再次执行生成、测试、`prepare-release`、真实 Wrangler dry-run 和 clean-source gate；它必须在最终提交已推送后执行。`.wrangler/release-manifest.json` 是忽略的发布工件，后续部署、evidence 与 metadata publisher 必须连续使用该文件，不得在中途换 HEAD 或重新解释工作树。

### 1. 只读回滚锚点

Preview 先行；production 使用对应资源名重复：

```bash
npx wrangler deployments status --name bdfz-curriculum-atlas-preview --json
npx wrangler d1 migrations list bdfz-curriculum-atlas-preview --env preview --remote
npx wrangler d1 time-travel info bdfz-curriculum-atlas-preview --env preview --timestamp <RFC3339_NOW> --json
umask 077
curl -fsS -X POST \
  -H "Authorization: Bearer ${CURRICULUM_RELEASE_COORDINATOR_TOKEN}" \
  'https://bdfz-curriculum-atlas-preview.bdfz.workers.dev/api/admin/release-coordinate?operation=inspect-pointer' \
  --output .wrangler/rollback-pointer-receipt.json
node --input-type=module -e "import {readFile} from 'node:fs/promises'; import {parseRollbackPointerReceipt} from './scripts/publish-metadata.mjs'; parseRollbackPointerReceipt(await readFile('.wrangler/rollback-pointer-receipt.json')); console.log('canonical schema-2 rollback receipt verified')"
```

保存 Worker version/deployment、原始 D1 Time Travel JSON/bookmark、评论/举报/限流/AI 审计基线，以及协调器返回的 pointer ETag/version/SHA/bytes/release ID。只有 `exists: true`、schema 2 且 inner pointer canonical hash/bytes 自洽的 receipt 才能作为常规 R2 回滚目标；`exists: false` 只能记录为 pointer absent，不能伪装成已备份。Importer 还会在第一次 D1 mutation 前把未经改写的 Time Travel command receipt 写入 owner-bound import state。Pointer receipt 只提供经过核验的目标身份，绝不能把其中的 raw pointer bytes 直接覆盖回 R2。

### 2. Migration、owner fence 与协调器 secret

无新 schema 时沿用下列常规顺序。有 `0008`/`0009` 时必须使用上一节 fenced 状态机；下列命令不能绕过 dual-schema/bootstrap、stage-no-pointer 或 CAS 激活条件：

```bash
npx wrangler d1 migrations apply bdfz-curriculum-atlas-preview --env preview --remote
npx wrangler d1 migrations list bdfz-curriculum-atlas-preview --env preview --remote
# 仅在该 secret 尚未安装或已批准轮换时交互执行：
npx wrangler secret put RELEASE_COORDINATOR_TOKEN --name bdfz-curriculum-atlas-preview --env preview
```

本地 `CURRICULUM_RELEASE_COORDINATOR_TOKEN` 与 Worker secret `RELEASE_COORDINATOR_TOKEN` 必须引用同一批准的秘密值，但不得打印、提交或写入报告。确认 `0008_release_ownership_fences.sql`、`0009_compendium_embedded_items.sql` 已按序应用且 pending 为 0；`0008` 分离 corpus/import publication fence，并把 R2 coordination schema 提升为 3，`0009` 才加入篇目及讨论作用域。普通 owner expiry takeover 会增加 fence，旧 owner随即失效；一旦 coordinator 取得最长 600 秒的 activation claim，所有受支持的 owner acquisition/release 都必须等待该 claim 释放或有界过期，不能在 inventory validation 与 conditional pointer put 之间插入接管。

### 3. Corpus import

```bash
npm run corpus:build
npm run corpus:import:preview
```

- importer 先把完整 corpus builder inputs、manifest、text assets 与全部 SQL chunks 固定为一个私有只读快照，再取得 owner token/fence 并写 `in_progress`；
- 同一 private snapshot 的 corpus identity 必须和 `.wrangler/release-manifest.json` 中的 corpus pin 完整相等，live 与 snapshot 两次核对都在第一次远端 mutation 前完成；换 manifest、换 SQL、换 desired artifact 均 fail closed；
- 每个 chunk 的数据变更与实际执行 snapshot 的 name/hash/bytes/owner/fence receipt 在同一 guarded D1 batch 中提交，不能出现数据已写而 receipt 丢失；
- 客户端中断时先查询远端 receipts，只从第一个未提交的精确 chunk 恢复；
- 同一 owner 可续期；expiry takeover 必须取得更高 fence。旧 owner 的 start/chunk/failure/resume/finalize/renew 全部 fail closed；
- 不盲目重放，不跳过 receipt，不把部分导入写成 ready；
- finalize 只在 196/16,456/16,456/6,031/16,456/0/91 等 manifest 计数全部相等时写 `ready`；同一精确 release 已为 `ready` 时 importer 只释放临时 owner 并返回 `already_ready`，不清空 receipt、不把 site metadata 倒退为 `in_progress`。

恢复参数以 importer 输出的首个未提交编号为准：

```bash
npm run corpus:import:preview -- --from <NNN>
```

### 4. Exact Worker deploy 与 artifact-bound environment evidence

```bash
npm run deploy:preview
npm run release:evidence:preview
sha256sum .wrangler/release-manifest.json
```

Deployer 重新验证 clean/upstream-exact HEAD，从 Git blobs 构建 `dist`，再把完整 exact tree 复制到第二个只读目录并只从该目录调用 Wrangler。部署变量中的 Git/release/manifest/source-tree/corpus 六个 pin 必须与 `.wrangler/release-manifest.json` 完全一致；工作树在检查后发生变化也不能进入部署。

Evidence 写入忽略的 `.wrangler/release-environment-evidence.json`，而不是修改 tracked source；publisher 通过显式 `--evidence` 读取它，因而 clean-source gate 仍能精确等于 artifact Git HEAD。Evidence 必须来自命令回执，不手改字段绕过 policy。采集后若 D1、Worker、Assets、corpus 或 artifact bytes 发生变化，重新采集；不得重新生成不同 desired release 后沿用旧 evidence。

### 5. Versioned R2 发布

```bash
npm run metadata:publish:preview
```

发布器先取得对应环境 D1 的 publication owner token 与单调 fence；所有 R2 create、inventory 与 activation 只通过带认证的 Worker coordinator 执行。Coordinator 逐请求核对 live owner/fence/expiry，以 `If-None-Match: *` 创建不可变对象，分页列举并重新 GET 完整 release prefix，再取得最长 600 秒的 D1 activation claim，在 claim 内重做全量 validation 并用 predecessor ETag 的 `If-Match`（或 absent pointer 的 `If-None-Match: *`）激活 schema-2 pointer。每个对象的 body hash、bytes、HTTP `Content-Type` 与 custom metadata `content_type` 必须同时精确匹配 manifest；只匹配 hash/bytes 仍不合格。Fence 必须严格前进；lease/owner 丢失、activation claim 冲突、predecessor 改变、prefix 缺失/多余/污染或已有 immutable key bytes/metadata/Content-Type 不一致都 fail closed。Claim cleanup 异常时不允许 owner 提前释放，而是最多等待 600 秒有界过期。中断时：

1. 先读取 current pointer、目标 manifest 与对象列表；
2. 若 pointer 未切换，旧 release 仍在线，新不可变对象可安全保持未引用；
3. 若 pointer 已切换，完成全量 readback 后再决定是否回滚；
4. 不盲目重跑。相同 release ID 的 immutable key 可能已经存在；只有 exact-body/metadata 重试可幂等成功，collision 拒绝是保护，不是要求覆盖；已精确激活同一 release 的重试只作 readback，不改写 `published_at`。

该协调同时使用 D1 owner/fence 与 R2 原生 conditional write。发布和回滚窗口内禁止 dashboard、裸 `wrangler r2 object put/delete` 或其他绕过 coordinator 的 pointer/immutable-key 写入。当前 schema-1 pointer 可在其 predecessor manifest body 与 pointer 内 SHA/bytes 精确一致时由首个 schema-2 高 fence release 接管；不得为了迁移而手工覆盖旧 manifest 或 pointer。

Production 已完成首次 `--bootstrap`，后续不得再次假定 pointer absent；正常使用 `npm run metadata:publish:production`。

### 6. Preview 验收后提升 production

```bash
curl -fsS https://bdfz-curriculum-atlas-preview.bdfz.workers.dev/api/health
curl -fsS https://bdfz-curriculum-atlas-preview.bdfz.workers.dev/api/meta
curl -fsS 'https://bdfz-curriculum-atlas-preview.bdfz.workers.dev/api/search?q=核心素养'
curl -fsS https://bdfz-curriculum-atlas-preview.bdfz.workers.dev/api/source-manifest
```

完成 desktop/mobile 星图、全隐藏、单科自动适配、语文深挖、年代、资料/版本、AI/讨论、刷新和深链接；再回归 User Center、Nav、Portal、Companion、APIS 与 Pulse。关闭任务浏览器并执行 Playwright orphan dry-run。

Preview 与 production 必须使用同一个 fenced desired-release artifact 重复完整链路：prechange receipts → `0008`/`0009`/secret 检查 → fenced exact corpus import → immutable prepared-tree Worker deploy → `.wrangler` environment evidence → coordinator D1/R2 activation → API/browser/dependency QA。两个环境中途都不得更换 Git HEAD、source-tree、corpus、manifest 或 artifact bytes；不得退回旧的 push → verify → R2 叙述绕过 desired-release/coordinator。

普通 compatible Worker 发布和 preview ontology promotion 不读取 preview acceptance receipt。只有把可发布 ontology 从已验收 preview 提升到 production 时，必须提供一个符合 `data/ontology-preview-acceptance-receipt.schema.json` 的 content-addressed receipt：

- `source.git_head` 必须等于本次 production deploy 的初始 clean/upstream-exact Git HEAD；
- `source.ontology_manifest.sha256` 必须同时等于 ontology validator 实际读取的 manifest bytes 和 release manifest source-tree 中同一路径的 SHA-256；
- `preview.deployment_id` 与 `preview.version_id` 必须是本次验收对象的精确 UUID，Worker 固定为 `bdfz-curriculum-atlas-preview`；
- `acceptance.status` 必须为 `accepted`，并保留验收人和 RFC3339 UTC 时间；
- `receipt_sha256` 是删除该字段后按稳定键序 JSON 序列化所得 SHA-256。任一字段变化都会让 receipt 失效。

测试夹具只说明格式，不得用于真实 promotion：`tests/fixtures/ontology-preview-acceptance/accepted.json`。真实 receipt 应保存到任务证据目录并作为不可变验收证据保留，不要把未验收或伪造的 deployment/version 写成 accepted。

Production ontology promotion 使用：

```bash
npm run deploy:production:ontology-promotion -- \
  --preview-acceptance-receipt <PREVIEW_ACCEPTANCE_RECEIPT_JSON>
```

Deploy wrapper 会在调用 Wrangler 前依次证明：initial Git clean/upstream exact；从该 HEAD 物化的 prepared tree 不含 `.git` 且 source-tree bytes 不变；ontology validation bytes 与 release manifest source tree 相同；release manifest 的 `git.head` 等于 initial HEAD 且 `git.dirty=false`；receipt 精确绑定同一 HEAD/ontology SHA/preview deployment/version/accepted status；Wrangler 前后再次验证 deployment snapshot bytes。任何阶段漂移都 fail closed，Wrangler 不会启动。

Page-evidence promotion 与 ontology promotion 可以在同一 HEAD、同一 desired-release artifact 和同一次 immutable prepared-tree Worker deploy 中原子完成；不能先部署其中一半再换 artifact。组合 promotion 使用顺序无关的 flags：

```bash
npm run deploy:production:ontology-promotion -- \
  --page-evidence-promotion \
  --preview-acceptance-receipt <PREVIEW_ACCEPTANCE_RECEIPT_JSON>
```

组合路径必须同时通过 page-evidence promotion gate、ontology manifest/source-tree SHA binding、preview acceptance receipt 与 immutable prepared-tree/deployment-snapshot 检查；任一失败时 Wrangler 调用数必须为零，并清理 prepared tree 及其 deployment snapshot。

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

常规 R2 回滚是一次新的、高 fence 的 pointer transition：重新激活已核验且仍完整不可变的 predecessor release，而不是复制旧 pointer bytes、覆盖 immutable object 或降回旧 fence。执行前必须让当前 desired-release 对应的 Worker、D1 migrations、corpus 和 environment evidence 仍全部健康；随后 publisher 验证 receipt 的 canonical schema-2 identity，取得新的 D1 publication owner/higher fence，通过 coordinator 重验目标 release 的完整 prefix/manifest/body hash/bytes/HTTP Content-Type/custom metadata，并以当前 pointer ETag/version 条件激活：

```bash
# 先把要回到的历史 inspect-pointer 原始 JSON 放在这个 task-private 文件；
# 命令会在任何 pointer mutation 前再次核验 receipt 和当前 desired environment。
npm run metadata:rollback:preview
npm run metadata:rollback:production
```

两个命令都读取 `.wrangler/rollback-pointer-receipt.json`；每次只保留目标环境对应的 receipt，并在执行前重新运行上文 canonical validation 命令。成功后必须读取新 pointer，确认 target release ID / manifest SHA / 新 fence，并重跑 `/api/health`、`/api/source-manifest`、搜索和浏览器回归。历史 immutable objects 保留，未引用对象不影响线上。

Production 的 stable-key fallback 和 Preview 的历史 predecessor 仍是灾难恢复锚点，但任何需要直接删除 pointer 的应急操作都属于另行审批的维护程序：先冻结所有 publisher、证明 owner/写入者静默、保存远端 readback 和明确恢复步骤，不能作为常规 R2-only 回滚命令执行。R2-only 回滚本身不应改动 corpus 数据或 Worker。

### 公共注册

普通代码/数据回滚不删除稳定 `siteKey`。只有产品撤回时，才作为一个事务同步 User Center、Nav、Portal、Companion 与 Pulse。

## 私有加密档案

本地索引：`backups/curriculum-atlas/private-archive/20260717T021000Z/archive-index.json`。远端精确前缀包含 14 个加密 parts 与最后上传的 index，共 15 objects / 3,304,581,750 bytes；完整 GET、逐 part SHA-256、decrypt、decompress 与 raw/evidence manifest replay 均通过。密钥不进入 Git、报告、命令或日志。删除该前缀属于独立破坏性动作，必须另行明确授权。

## 禁止事项

- 不从 dirty tree、stale `dist`、过期 environment evidence 或未 ready corpus 发布；
- 不把 OCR complete、Vision complete、远端 staging 或 B-r1 partial state写成可显示/可引文正文；
- 不在没有 hash-bound seed lineage 时把 B-r1 输出复制到新配置；
- 不手工覆盖 immutable R2 objects，不绕过 D1 owner/fence 与 Worker coordinator 写 pointer，不跳过 exact prefix inventory/readback，不在中断后盲目重跑；
- 不使用 `INSERT OR REPLACE INTO documents` 破坏评论外键；
- 不把扫描原件、完整受版权约束 OCR、secret、cookie、session 或用户内容放入公开 R2、Git 或报告。
