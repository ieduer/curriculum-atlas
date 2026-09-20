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
- 首页只有一张 Canvas；不得出现第二 timeline 或虚线 primitive。

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

每次生产发布至少验证：

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
