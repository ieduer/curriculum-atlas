## Current accepted state — 2026-10-26 14:34 UTC

Owner: suen. Runtime source `59182954a4d7075850a24c42fb48aa34776ef078`
(branch `claude/curriculum-integrity-cache-20261026`, fast-forwarded into
`main`), Worker version `5fd7acd6-966a-4e9b-a4d9-d8ad095b98ae` at 100%,
deployment `34a6bdfe-29bc-454d-96ca-2f1bf411dad2`, effective 14:34:47 UTC.
Worker read-path change approved by the owner: read routes reuse the
full-corpus integrity count per active release pointer for at most one hour
per isolate; `/api/health` always recounts (see “语料完整性计数复用”). Only
`src/index.ts` changed; static dist byte-identical to `b3ca312`; data, schema,
bindings, routes and asset headers unchanged. Rollback: version
`9742118f-aecd-4a38-8ecb-8bba53dfa88c` (source `b3ca312`, deployment
`f964ed6c`) via a new registered transaction; no data to restore. Preview
Worker active deployment unchanged; immutable preview version `015c9f1a`
(source `5918295`) exists, not deployed.

Gate: `tsc`; full suite candidate 667/662/3/2 vs base `bfa1faf` 658/653/3/2,
identical failures (+9 tests); build and dry-run; runtime/bindings review;
gitleaks clean; preview-version, version-pinned and production probes; D1
rows-per-request measurement before/after. Evidence:
`/Users/ylsuen/CF/_meta/reports/operations/curriculum-integrity-cache-20261026/README.md`.

## Previous accepted state — 2026-10-26 14:13 UTC (superseded 14:34 UTC)

Owner: suen. Runtime source `b3ca312944201f8a2f8f30567e744ee1c35a99c3`
(branch `claude/curriculum-authority-20261026`, fast-forwarded into `main`),
Worker version `9742118f-aecd-4a38-8ecb-8bba53dfa88c` at 100%, deployment
`f964ed6c-b5e3-4178-b549-919d081a522f`, effective 14:13:32 UTC. Static
content release: `/library` 官方文库 and the Taiwan official-originals section
from `content/official-library.json` (47 verified official documents, 60 files
with size and SHA-256; see “前端合同” 官方文库 bullet), subject side panels,
文库 navigation. Worker module, runtime and asset headers unchanged; D1/R2
untouched. Reviewed required-file changes: `scripts/build-site.mjs`,
`site/boot.js`, `site/styles.css`; added `content/official-library.json`.
Rollback: version `02fcf5dc-e882-47aa-a1f0-3f93323cb04f` (source `085f656`,
deployment `183f3227`) via a new registered transaction. Preview Worker active
deployment unchanged; immutable preview version `4a638729` (source `b3ca312`)
exists, not deployed.

Gate: `tsc`; full suite candidate 658/653/3/2 vs base `859ce3c` 657/652/3/2,
identical failures (+1 library test); build and dry-run (bundle = live module);
readability audit 40 runs, 0 failures, minimum 4.62:1, no overflow; gitleaks
clean; preview-version, version-pinned and production probes; live browser
check. Public record: status.bdfz.net `20261026-curriculum-official-library`
r1. Cloudflare usage analysis (30-day and hourly before/after, open
recommendation on per-request corpus integrity counts):
`/Users/ylsuen/CF/_meta/reports/operations/curriculum-authority-20261026/CLOUDFLARE-USAGE.md`.
Evidence: `/Users/ylsuen/CF/_meta/reports/operations/curriculum-authority-20261026/README.md`.

## Previous accepted state — 2026-10-26 13:24 UTC (superseded 14:13 UTC)

Owner: suen. Runtime source `085f65677ca7412995204049354243cd729fed65`
(branch `claude/curriculum-family-style-20261026`, fast-forwarded into
`main`), Worker version `02fcf5dc-e882-47aa-a1f0-3f93323cb04f` at 100%,
deployment `183f3227-83c3-4060-8dde-fb2b93a268d8`, effective 13:24:57 UTC.
Front-end restyle after the sy/cp series (see “前端合同” visual bullet); Worker
module, data, content and routes unchanged. Reviewed required-file changes:
`scripts/build-site.mjs`, `site/app.js`, `site/styles.css`,
`content/subjects.json`. Rollback: version `e078241f-55c0-4e1b-a722-5764e5f71002`
(source `538e2cf`, deployment `474b1e56`) via a new registered transaction.
Preview Worker active deployment unchanged; immutable preview version
`7fc28170` (source `085f656`) exists, not deployed.

Gate: `tsc`; full suite 652/3/2 on candidate and base `4c8a358` with identical
failures; build and dry-run (bundle = live module); readability audit 48 runs,
0 failures, minimum 4.62:1, no overflow; gitleaks clean; preview-version,
version-pinned and production probes; live browser check. Public record:
status.bdfz.net `20261026-curriculum-series-style` r1. Evidence:
`/Users/ylsuen/CF/_meta/reports/operations/curriculum-restyle-20261026/README.md`.

## Previous accepted state — 2026-10-26 12:50 UTC (superseded 13:24 UTC)

Owner: suen. Runtime source `538e2cfcaf9b31b9f20d7536edee80a58a61bb98`
(branch `claude/curriculum-redesign-20261026`, fast-forwarded into `main`),
Worker version `e078241f-55c0-4e1b-a722-5764e5f71002` at 100%, deployment
`474b1e56-85d8-4cdc-9403-dc2927cb59da`, effective 12:50:15 UTC. The Worker
module is byte-identical to the previous accepted bundle (`e70685f2…`); the
release changes static assets only (per-subject static redesign; see “前端合同”
below) and `RELEASE_GIT_COMMIT`. Asset header rules changed exactly as
`dist/_headers` (root `/*.js`, `/*.css` one-hour rules dropped; hashed
`/assets/*` immutable). Rollback: version `e4c24bc4-1015-4a35-84d2-77a5466c37f8`
(source `93fece8`, deployment `f38e0f33`) via a new registered transaction; no
data to restore. Preview Worker active deployment unchanged (`fc259ebe`);
immutable preview version `e935b39d` (source `538e2cf`) exists, not deployed.

Gate (front-end release): `tsc`; full suite 652 pass / 3 fail / 2 skipped with
the same 3 failures as base `fd63e2d` (645/3/2) and +7 site-build tests; build
and dry-run (production and preview bundles equal the live module); readability
audit 12 routes × light/dark × 1440/390, 0 failures, minimum contrast 6.21:1;
gitleaks clean; preview-version, version-pinned and production probes (all dist
files byte-equal after stripping edge-injected Zaraz/Web Analytics/bot links;
fallback routes; immutable asset cache; CSP; document/search 200; unauthenticated
AI refused); live browser check with no `/api` call on home load. Signed-in
paths (AI answer, historical scans, posting) were not exercised by the agent;
their Worker code is unchanged. `release:gates:check` still fails on the retired
OCR state and was not run.

Public record: status.bdfz.net `20261026-curriculum-subject-redesign` r1.
Evidence and receipts: `/Users/ylsuen/CF/_meta/reports/operations/curriculum-redesign-20261026/README.md`.

## Previous accepted state — 2026-10-17 08:50 UTC (superseded 2026-10-26)

Owner: suen. Runtime source `93fece839bdebbc27486d72214aa33700ef1b205`
(branch `claude/apis-compat-20261015`, merged into `main`), Worker
`e4c24bc4-1015-4a35-84d2-77a5466c37f8` at 100%, deployment
`f38e0f33-feb5-49c7-9de3-ffc984b939e0`, effective 08:50:38 UTC. Accepted after
version-pinned and production probes (health ok naming the source, `/` and all
84 `dist` files byte-equal to the build, unauthenticated AI refused) and the
owner's signed-in cited answer. Rollback: Worker
`f3e955af-89ca-4daf-8aab-79f3200d0123` (source `04c6831`, deployment
`c2b2baa4`) via a new registered transaction; retain all forward D1/R2 data.
The preview Worker's active deployment is unchanged (`fc259ebe`); immutable
preview version `53ef5ba4` (source `93fece8`) exists and is not deployed.

Change (APIS payload-contract rollout, phase A1): AI evidence answers send
retrieved passages whole, in retrieval order, within 160 KiB; an oversize
passage is skipped whole; only sent passages can be cited; responses add
`contextCount` next to `retrievalCount`; a typed 422 when no passage fits. No
asset, corpus, data, binding, route or schema change.

Release gate: `npm run release:gates:check` fails identically on `04c6831` and
`93fece8` because the retired OCR `.cache` state is deleted (7 of 10
sub-gates). Do not recreate that state. For this code-only release the owner
approved the code-only gate: TypeScript; the full suite (645 pass, 3 fail, 2
skipped, the same 3 failures as the base); the 3 runnable sub-gates
(`ocr:coverage`, `candidate:schema`, `release:episodes`); build and strict
dry-run; base build byte-identical to the live bundle; reviewed bundle diff;
secret scan. Run `npm test` with `TMPDIR` in a directory owned by the user's
group (`staff`): under `/private/tmp` new files get group `wheel` and 49 OCR
runner tests fail spuriously.

Upload: pass `--keep-vars --var RELEASE_GIT_COMMIT:<sha>` (as
`scripts/deploy-worker.mjs` does), so `/api/health` names the source. Script
settings carry that variable too, so configuration reconciliation must
account for it.

Public record: status.bdfz.net `20261017-curriculum-ai-evidence-context` r1.
Evidence and receipts:
`/Users/ylsuen/CF/_meta/reports/operations/apis-upgrade-design-20261014/RELEASE-ATLAS-20261017/README.md`.
The dated records below are history where superseded by this state.

## Previous accepted state — 2026-10-07 12:08 UTC (superseded 2026-10-17)

Owner: suen. Runtime source `04c6831a2b412c1ef1d79d694dfe69b2dff2f37b`,
Worker `f3e955af-89ca-4daf-8aab-79f3200d0123` at 100%, deployment
`c2b2baa4-db7c-4054-828b-ac404ea389ab`. Production became effective at
12:03:37 UTC and was accepted after runtime/configuration, real API, asset
and desktop/mobile readback. Rollback is the prior Worker
`09832541-e347-4fab-b64e-8b2072010c80` via a new registered transaction;
retain all forward D1/R2 data. The existing preview deployment is unchanged.

Paragraph and publication-gate totals now use one scan per current-release
set. The metadata response reuses the freshly validated document/paragraph
counts within the same request. Every request retains live release, manifest,
state and corpus integrity checks; there is no cached acceptance or new job.
Public assets, corpus, citations, authentication and retired OCR stay intact.

Validation: TypeScript, build, 63 focused Node 24 tests, strict dry-run,
exact-source secret scan, isolated candidate bundle parity, 83 public assets,
API and desktop/mobile acceptance. Initial raw metadata hash mismatches were
not payload-captured; their exact cause remains unknown. Bounded same-path
comparison of predecessor, candidate and production then proved every nested
value identical. Do not characterize the initial mismatch as a proven
serialization issue or use it to justify unbounded rechecking.

The central release authority stores the exact acceptance and rollback
receipts. Public maintenance record: `curriculum-reduce-repeated-reads-20261007`;
the registered publisher, immutable API, public page and both RSS views passed.
No further provider/OCR calls are authorized by this checkpoint. The dated
records below are history where superseded by this current state.

## 前端合同（2026-10-26 改版起；取代下文星图前端条款）

站点改为按学科分页的静态网站。旧版单一 Canvas 星图（`public/index.html`、`public/app.js`、`public/atlas.js`、`public/styles.css` 等）不再发布，源文件留在仓库作历史与数据层输入；下文 §3 “首页只有一张 Canvas”与 §5 星图浏览器回归条款自本次起作废。

- 生成：`npm run build` 运行 `scripts/build-site.mjs`，从 `data/catalog.json`、`public/data/century-observation-layer.json`、`public/data/pre2001-subject-detail-observation-layer.json`、`public/data/concept-evolution.json`、`public/data/discipline-lifecycle.json`、`data/subject-insights.json` 与 `content/*.json` 预渲染 `dist/`。前端源码在 `site/`（`boot.js`、`app.js`、`styles.css`），静态资源带内容哈希放在 `dist/assets/` 并按 `_headers` 长期缓存。
- 页面：`/` 首页（全人培养要求矩阵：大陆 16 条、台湾 6 条正式表述 × 8 维度；学科入口）；`/s/<slug>` 19 个学科与专题页（语文、数学、外语、思政、历史、地理、物理、化学、生物学、科学、音乐、美术、体育与健康、信息科技、通用技术、劳动、课程方案与学制、考试与评价、特殊教育）；`/taiwan` 台湾国语文课程标准与课程纲要（含官方课纲原件一节 `#library`）；`/library` 官方文库（全文库之外已核对的官方原件与通知页）；`/search`、`/ai`、`/discussions`、`/admin` 为调用 API 的应用页。`/document/<id>`、`/historical/<id>` 由 SPA fallback 的 `index.html` 渲染；旧链接 `/compare`、`/archive`、`/timeline`、`/subjects`、`/sources`、`/terms` 在浏览器端转到对应学科页或检索页。
- 资源与 API 约束：首页、学科页、台湾页、文库页加载时不调用 `/api/*`（旧版每次访问调用 `/api/meta`、`/api/documents?limit=200`、`/api/insights` 三次，各做一次全语料完整性计数，并解码约 24 MB 星图 JSON）。只有阅读正文、检索、AI 研究、讨论和审核时才调用 API。Worker 代码、D1、R2、绑定与路由不变。
- 内容依据：`content/whole-person-aims.json` 每条表述带原文、出处与维度短语；`content/taiwan-guowen.json` 每个版本标“官方原文／研究文献／报道”，比例和选文只取官方原文；`content/subjects.json` 定义学科页的文件归属规则与检索身份（须是 Worker 接受的 `/api/search` 学科身份）。
- 官方文库（2026-10-26 加入）：`content/official-library.json` 只收教育部、国务院、国家教材委员会及台湾教育部、国家教育研究院、国民及学前教育署官网的原件或通知页（修订动态可引新华网与人教社期刊，并标“修订动态”）。每项记标题原文、发文机关、文号、成文与发布日期；每个文件记格式、字节数与 SHA-256（RAR 只核对大小）。条目不进 D1 全文库，学科页侧栏“官方补充文件”与台湾时间轴“官方原件”链接都从这里生成。增删条目时先下载核对，再改 JSON，`tests/site-build.test.mjs` 会检查来源域名、摘要格式、学科与台湾版本引用。生成器与核对记录在 `_meta/reports/operations/curriculum-authority-20261026/`。
- 视觉（2026-10-26 二次改版）：与辞渊 sy.bdfz.net、风雅千载 cp.bdfz.net 同系——宣纸底色、朱砂主色、系统宋体标题、朱印徽标、居中衬线标题与胶囊检索框、红条小节标题、左侧色边学科卡片、“全部”在前的单选筛选、手机底部导航栏（共享登录挂件经 `data-mobile-inset-bottom=76` 抬到底栏上方）。墨色主题沿用 cp 的深纸配色。为可读性，辅助文字比 sy 原色加深（`#6b6253`），所有文字对比度 ≥4.5:1。不加载网络字体。
- 门槛：`tests/site-build.test.mjs`（年份规则、19 页齐全、196 份文件无遗漏、历史条目身份规则、页面无内联脚本与星图数据、内容引用一致）；逐路由对比度量测（亮/暗 × 1440/390，文字对比度 ≥4.5:1、大字 ≥3:1、无横向溢出）；生产发布按已登记的 Worker 交易（预览版本 → 0% 附挂 → 版本固定探测 → 推广 → 生产探测）。

## 语料完整性计数复用（2026-10-26 起；站长在会话中批准）

全语料完整性计数（`currentCorpusRelease()`：当前 release 的段落、FTS、页级发布门、文件与 13 张核心表计数）每次约读 4.5 万行。自 2026-10-26 起：

- 读路由（`requireCorpusReady()` 之后的 meta、documents、search、insights、terms、compare、source-manifest、comments、historical、AI）先做一次只读 release 行的指针查询（`currentCorpusPointer()`：`corpus_import_releases` 经 `site_meta` 的 `current_corpus_release_id`、`corpus_import_state`、`current_corpus_manifest_sha256` 联结）。指针行除 `live_*` 外每一列都参与身份比较；身份不变且同一 isolate 内距上次完整计数不足 1 小时，就复用那次通过的结果，否则重新完整计数。
- 只复用通过的结果；任何一次完整计数不通过都会清除复用，下一次读请求重新计数。指针查不到（release、manifest 或 state 不符）直接 503，不看复用。
- `/api/health` 每次都完整计数，并用结果替换或清除复用；发布验收与漂移排查以 `/api/health` 为准。同一指针下的表数据漂移，读路由最迟 1 小时或下一次 `/api/health` 后看到。
- 复用只存在 isolate 内存，不新增绑定、KV、Cache API 或 D1 写入。门槛：`tests/corpus-count-reuse.test.mjs`（指针查询与完整计数的 release 列一致、失配即无行、任一 release 列变化即换身份）与 `tests/worker-api-cost-boundary.test.mjs`（复用、health 重算、失败不复用、指针变化与 1 小时过期即重算）。

# 运维与八点验证标准

> 完整 Git 时间线、append-only 事件和历史回滚见 [`project-operations-ledger.md`](project-operations-ledger.md)。本文件定义当前 v20 运行标准。

## 当前检查点

- Production：Worker `104ccefa-baf0-4c96-ae4b-8c1c4e25dc38`，deployment `b05cc96f-30ae-4b04-b652-a1f053314163`，release Git `d1568222d6998d36644d56be0c70fe7a02aed489`。
- Preview：Worker `3c6f19e3-51b6-456f-9258-b09671d4d2cf`，deployment `fc259ebe-2ba0-40b9-8e5e-493d4c270eb4`，release Git `d1568222d6998d36644d56be0c70fe7a02aed489`。
- GitHub main 含 caller-check functional source `0f8763b`，但 production 已由 D20 停止门恢复到 `104ccefa…`，当前 deployment `b05cc96f-30ae-4b04-b652-a1f053314163`。候选 `11555d36-e0cf-46d7-b991-bad793668cce` 的 0% 精确探测于 `2026-08-29T14:58:27Z` 返回 HTML 200：`assets.run_worker_first` 尚未纳入 `/__caller-check`，所以路由未进入 Worker。Preview 未部署、未改配置。
- 两端 D1 migration `0001`–`0007`，corpus `corpus-1c4f6b41737380f3e71246dd` ready，R2 current `release-cd9ec4a050cbabbede744192398ebfa7`。
- 单一星图：2,415 episodes、3,144 edges、5,304 evidence；55 families、1,648 memberships；11 个公开学科分面。
- OCR：已完成子集 6,947/6,947 页机器终局；30 个唯一可引页；83 份完整文件／10,210 页进入 308 个候选观察；462/462 个 2001 年前 bounded identities 通过。2026-08-12 用户正式终止未完成的本机自动 OCR：冻结总分母为 11,847 页，其中 6,947 完成、4,900 待处理、1 页隔离；未完成页不再自动续跑，也不取得候选或引文资格。

## 1. Source of truth

代码、schema、builder、公开元数据和发布收据来源为 `/Users/ylsuen/CF/curriculum-atlas`。原 PDF/页图和被冻结的本机 OCR evidence 是原始事实；D1、R2、Worker Assets 是可重建部署物。

四种状态不得混写：

- OCR machine disposition：页级机器裁决；
- page/corpus publication：正式显示与引文；
- candidate observation：星图词面候选；
- semantic relation：独立证据支持的语义关系。

`data/release-environment-evidence.json` 是采集快照，不自动跟随随后激活的 R2 pointer；post-evidence pointer 必须由 append-only readback 事件证明。

## 2. Health probe

`GET /api/health` 必须为 200、`ok=true`，并满足：

- `version=2026.07.24-v18`；
- schema 3、taxonomy 2、page-publication 1；
- 196/196 classifications，159 subject、1 assessment subject、16 course、20 scope、0 unclassified；
- 12 storage facets、11 public facets；
- D1、R2、APIS、User Center、Assets 五项 binding 全真；
- current corpus `ready`，expected/actual/live 精确为 196 / 16,500 / 16,500 / 8,808 / 16,500 / 26 / 103。

任一 corpus drift 返回 503。

## 3. Contract check

- `data/data-quality-standard.json` 的 34 项检查必须全过，且 `manual_override_allowed=false`。
- 6,947 页机器裁决：31 exact + 73 blank + 5,063 text-conflict closed + 1,780 table-conflict closed，pending 0、human-required 0。
- 正式 publication：31 receipts → 30 unique pages → 26 documents → 44 paragraph candidates；未列入 manifest 的页默认关闭。
- 候选层：83 complete documents、10,210 pages、308 episodes，全部 `semantic=false`、`citation_allowed=false`。
- 462 个 pre-2001 identity receipts 必须唯一、来源页段闭包、failed 0。
- 55 同层 families、1,648 memberships、1,348 edges 的端点、年份方向、证据和 fail-closed claim policy 必须全部有效。
- 历史与历史社会在存储身份上分开、公开检索合并为“历史”；不得自动判为 identity equivalent。
- （2026-10-26 起作废，见“前端合同”）首页只有一张 Canvas；不得出现第二 timeline 或虚线 primitive。

## 4. Deploy and forbidden actions

标准流程见 [`deployment.md`](deployment.md)：回滚锚点 → deterministic builders/full verify → preview corpus/Worker/evidence/runtime/browser → production corpus/Worker/evidence → R2 pointer → production browser/readback。

禁止 dirty-tree 部署、跳过 receipt、覆盖 immutable R2 key、把 candidate 冒充 citation、生成冲突页第三份文本、修改共享 hub 或旧 OCR runtime。

### APIS caller contract（2026-08-28）

- Production 只走 `APIS` Service Binding，caller ID 固定为 `curriculum-atlas`，专用凭证只存在 Cloudflare secret `APIS_CALLER_TOKEN`；缺失时 503 fail closed。
- Preview 明确配置 `APIS_ENABLED=false`，在检索和 provider 调用前 503；它不注册 caller，也不领取凭证。
- 不允许 binding 回应后再向公开 `apis.bdfz.net` 发第二次请求。
- Main 的 caller-check handler 沿用 production `AI_ORIGIN=https://curriculum.bdfz.net`、caller ID、binding 与凭证，只访问 `/caller-identity`；preview 单测为 `configuration_unavailable` 503 且不调用 APIS。该 handler 当前未上线，因为 Static Assets `run_worker_first` 不含此路径。D20 将 HTML fallback 分类为确定性失败，因此不得把 source presence 写成 live evidence。
- 当前 retired-OCR 状态使旧 `npm run verify` 在读取已删除的 `.cache/ocr-production/*/state.json` 时先行失败。不得恢复或合成该热状态来取得绿灯；本次 APIS-only 发布门为 TypeScript、37/37 backend tests、build、strict dry-run、commit gitleaks 与双环境 live health。验证标准的退役态修订必须另行审查。

## 5. Dependency and browser regression

（星图条款自 2026-10-26 起作废；现行浏览器门槛见“前端合同”。共享依赖条款仍适用。）每次生产发布至少验证：

- `my.bdfz.net/site-auth.js`、`apis.bdfz.net`、Nav 注册与 Pulse tracking 的只读合同；
- 1440×1000 与 390×844；
- 单一 Canvas、暗/亮主题、多年份任意组合、年代和年份模式互斥；
- 实际点击星点后整族高亮、关系线为实线、镜头放大；
- inspector 不覆盖 safe viewport：桌面移到星群对侧，手机置于底部；
- `scrollWidth=innerWidth`，console error/warning 0；
- 命名浏览器关闭和 Playwright orphan dry-run。

v18 实测：1902 + 2022 对比 223 个可见星点；“阅读与鉴赏”4 个同层概念／58 个观察点同时亮起；亮色深蓝实线清晰；desktop/mobile 均无 overflow。

## 6. Backup and restore

- Production D1：bookmark `000000d6-00000000-000050b2-6e1bdf145e5aea4b984d2581ca5724f9`；非 FTS 业务 SQL backup SHA-256 `f818303b79fee2c41d7a5d2ef24542edff42e9a0d9b228a225c9c04319c3fc4f`，27,778,486 bytes。
- Preview D1：bookmark `00000071-00000000-000050b2-0b529d53eb22aae53e6dc536a85995cc`；非 FTS 业务 SQL backup SHA-256 `1d082642da0e5b8b0ea44c71ba12c903c39a558ea3a86591859127139e62533e`，27,806,245 bytes。
- Git：tag `curriculum-baseline-20260724-v17-3f8951d8`；backup branch `backup/curriculum-v18-machine-publication-light-lines-20260724`。
- 私有加密档案索引：`backups/curriculum-atlas/private-archive/20260717T021000Z/archive-index.json`。密钥不进入 Git、报告或日志。

### Retired local OCR automation

- Retirement authority: explicit user decision on 2026-08-12.
- Frozen status before stop: 11,847 total pages, 6,947 completed, 4,900
  pending, one quarantined page (`legacy-compendium-chemistry:84:paddle`),
  watchdog held, and no active OCR child.
- The installed LaunchAgent
  `~/Library/LaunchAgents/com.suen.curriculum-ocr-watchdog.plist` was unloaded
  and removed. The project template remains at
  `ops/launchd/com.suen.curriculum-ocr-watchdog.plist` as historical/recovery
  documentation only.
- The watchdog wrote terminal state `stopped`; its PID, `caffeinate` child,
  launchd label, and lock are absent. Source PDFs, completed primary/witness
  evidence, audits, manifests, quarantine records, private R2 objects, and
  encrypted archives were not deleted or modified.
- Do not reinstall, bootstrap, or change `watchdog-control.json` from `hold`
  without a new explicit authorization. A future restart is a new OCR project,
  not routine maintenance, and must first revalidate the frozen denominator,
  disk budget, runtime/model identities, retention, and publication gates.

Time Travel 恢复前先检查 bookmark 后的合法用户写入；业务 SQL 是辅助审计副本，不包含 FTS virtual table，不能描述为整库备份。

## 7. Rollback

- Current APIS migration production predecessor：`104ccefa-baf0-4c96-ae4b-8c1c4e25dc38`
- Current APIS migration preview predecessor：`fdc9b9f2-7698-47b6-9663-44475786de34`
- 回滚只恢复对应 Worker version；D1、R2、corpus pointer 和专用 secret 不变。确认旧版本不再有候选流量后才可移除 secret。
- B5-3 将 `/__caller-check` 加入 Static Assets `run_worker_first`，production 通过 0% / 1% / 5% / 100% 逐级读回后运行 `806c690c-e31a-419e-94d2-796e9f5e4bbc@100%`；即时回退为 `104ccefa-baf0-4c96-ae4b-8c1c4e25dc38`。Preview 保持 `3c6f19e3-51b6-456f-9258-b09671d4d2cf@100%`。

- Production Worker predecessor：`3f8951d8-28ce-4b53-b936-5411b4d23b73`
- Preview Worker predecessor：`faa7a9bf-e010-42d7-b635-332486f4b0fc`
- Production R2 predecessor：`release-9cb02f77c06ee0535e7981a22b312373`
- Preview R2 predecessor：`release-841a528f0086ce69f2f7a6f2d07c0999`

R2-only 回滚只恢复 predecessor pointer bytes，保留 immutable v18 objects。回到 v17 Worker 时必须耦合评估 D1，因为旧 Worker 内嵌旧 corpus fingerprint/counts。

## 8. Last verified

B5-3 于 2026-08-29 验证 main `31f9dfb`：Node 24.18.0 TypeScript、37/37 backend tests、deterministic build、strict production dry-run、exact-commit gitleaks 和 clean-source deploy gate 通过。候选 `806c690c-e31a-419e-94d2-796e9f5e4bbc` 在 0% / 1% / 5% / 100% 均返回 HTTP 200 `application/json`且 `identityStatus=verified`；production deployment 为 `d5574ab0-a6f0-4d90-ad7f-df5e71bf2538`，preview 未变。发布后完整 caller 表为 24/27；`flx` 首次出现一次 fetch failure，两次 no-cache 确认与下一次全表均通过，按 D20 记为 1/3 抖动而非回归。

Production evidence 采集于 `2026-07-24T09:15:43.645Z`：Worker `10c8d648…`、deployment `38cb4825…`、health 200、corpus ready、五项 assets byte parity 通过。随后 production R2 在 17/17 object readback 后于 `2026-07-24T09:18:57.787Z` 激活 `release-cd9ec4…`。

正式浏览器只读验收：

- desktop 1440×1000：亮色、1902+2022、多年份、实际 Canvas 点击、58 点演进链、inspector 对侧 safe viewport、无 overflow；
- mobile 390×844：单一 Canvas、bottom inspector 不侵入 safe viewport、无 overflow；
- console errors 0、warnings 0；命名会话 `curriculum-v18-production` 已关闭。

## 日常检查

- 每次发布：`npm run verify`、environment evidence、R2 readback、API/browser QA、action log、canonical report、operations ledger、rollback anchor、Playwright cleanup。
- 每周：OCR failure/quarantine、机器 disposition 总量、publication manifest diff、AI 引文失败、Worker 错误率。
- 每月：官方修订动态、来源 URL、D1 corpus counts、R2 pointer/manifest/object 与本地 hash 对账。
- 新增或更换扫描：重算源 SHA，重新入队，不继承旧页通过状态。

## 2026-08-30 Turnstile 提交边界加固

匿名评论仍是逐次写入、逐次验证：每次提交必须取得 action
`curriculum_comment` 的新 token，Worker 仅接受
`curriculum.bdfz.net`，并在 8 秒内向 Siteverify 以表单编码和幂等键
校验，任何超时或响应异常均 fail closed。本次不建立 30 分钟会话，
因为评论是公开写入面；30 分钟复用只适用于受限流保护的 AI 读取/推理。

验证：Node 24.18.0 `npm run check` 与完整 `npm test` 通过；
preview 未改。生产回滚锚点为
`806c690c-e31a-419e-94d2-796e9f5e4bbc`。

正式回读：GitHub merge `ab5ef83`；Worker deployment
`1108163c-f95b-4d8b-afcd-a3941253f5f1` / version
`c7259ead-9cf9-4f93-94db-dfeba4b9520e` at 100%；`/api/health`
为 `ok:true` 且 `release.gitCommit=ab5ef83...`。preview 未改。

## 2026-09-20 query-cost release

Production source `b74659c742e692c07f5205fdb3c0dc67ba17f3a4` is deployment
`411fa14b-f7c4-465a-9e57-9404b7578ded`, Worker
`09832541-e347-4fab-b64e-8b2072010c80` at100%. Rollback is
`c7259ead-9cf9-4f93-94db-dfeba4b9520e`; use a new registered rollback receipt,
never replay the consumed release receipt. No D1/R2 migration or data write.

Unknown/wrong-method API routes return404 before corpus/session reads. Valid
routes keep live corpus integrity and citation/authentication gates. Eligible
fallback searches use existing trigram LIKE; fewer than3 Unicode characters
or backslash/percent/underscore/NUL keep the original fallback semantics.
The original MATCH path and ranking are unchanged.

Read-only production evidence: no-result long searches16501→1 row; 核心素养
fallback20616→6860; a subject-filtered case17873→4117. Six before/after
queries had identical full returned rows and order;16500-row FTS projection
matched paragraphs. Two-character and special-character queries remain costly.
Valid requests still perform full corpus integrity counts; this is no account
spending cap.75 focused backend/security/retrieval tests, TypeScript, build,
strict pinned-Wrangler dry run and exact-commit gitleaks passed.

Validation for this runtime-only release compared all unchanged public assets,
source/migration/config hashes and live corpus counts instead of rebuilding
retired OCR state. Legacy full verify still requires deleted OCR hot state and
was not claimed passed or restored. Immutable isolated preview and production
candidate bundles were byte-identical;83 public assets and13 HTTP cases passed
in preview and production. Cross-environment paragraph primary keys differ;
all other search fields and ordering matched exactly. Production before/after
results also matched including IDs.1440×1000/390×844 browser checks passed.
Production preview URLs stayed disabled; isolated preview's active deployment
was unchanged. Exact evidence: `/Users/ylsuen/CF/reports/operations/cloudflare-risk-atlas-20260920/REPORT.md`.
