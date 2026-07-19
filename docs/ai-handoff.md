# AI / 开发者接手说明

## 必读顺序

1. `README.md`
2. `docs/architecture.md`
3. `docs/data-methodology.md`
4. `docs/ocr-quality.md`
5. `docs/data-model.md`
6. `docs/deployment.md`
7. `docs/operations.md`
8. `docs/project-asset-ledger.md`
9. `docs/project-data-integrity-audit-2026-07-16.md`
10. `docs/project-operations-ledger.md`
11. `/Users/ylsuen/CF/runbooks/bdfz_project_matrix_and_interdependencies.md`（仅 BDFZ 内部运维环境）

## 不可突破的边界

- 不把低质 OCR、目录元数据、搜索摘要或模型补写当作原文。
- 只有同文同版在线文本可以校正文句；异版只能旁证稳定事实。
- 冲突未解决时标记 `human_judgment_with_warning`，说明风险并保持引文关闭。
- 不把原始 PDF、整本受版权约束转录、用户数据或秘密提交到 GitHub/R2。
- 不为叶项目创建 Gemini key；只用 `APIS` binding。
- 不绕过 User Center 自建账户系统。
- 不直接试错生产；先在 preview 完成迁移、数据和浏览器验证。
- 不把 tracked `data/release-environment-evidence.json` 当作会自动跟随 R2 pointer 更新的实时状态。Fenced publication v2 的运行期 evidence 在 `.wrangler`，且 pointer 激活必须查 coordinator exact-prefix/pointer readback 与 append-only 事件。
- 不在新并发/idle/runtime 配置下直接复制 B-r1 state；复用完成页必须有 hash-bound seed lineage 与 predecessor receipt。

## 修改闭环

1. 确认来源与实际运行路径。
2. 对风险变更记录备份/Time Travel/Worker 版本。
3. 做最小修改并运行 `npm run verify`。
4. 在 preview 验证 health、meta、搜索、详情、AI、身份和讨论。
5. 发布后回归 User Center、Nav、Portal、Companion 和 Pulse。
6. 更新 `CHANGELOG.md`、项目运维文档、canonical report 与 action log。

## 当前已上线基线

- Preview/production 均已应用 migration `0001`–`0007`，运行 v10、schema 3 / taxonomy 2 / page 1。
- 这是 legacy 线上基线；本仓库的 `0008_release_ownership_fences.sql`、唯一 desired-release v2 artifact、D1 owner/fence 与 R2 conditional coordinator 在完成真实 preview/production 验证前均不得写成已上线。
- Corpus `corpus-358471fcce862b2f0ae446fc` 两端 ready：196 documents、16,456 paragraphs、16,456 FTS、6,031 page gates、16,456 displayed、0 accepted OCR、91 chunks。
- Taxonomy 精确为 159 subject、1 assessment subject、16 curriculum course、20 scope、12 display facets、28 ordinary query identities。
- Production version/deployment 为 `28c7e6d4-1638-42bc-b371-bd8d24210b93` / `baa8a92f-ccc8-4972-b0ad-6d67876cdc84`，Assets Git `57487dc95481391cbcd40e0be0c92ee2d1ed8fdf`；preview 为 `2d107d38-cf31-49b6-82b1-20b32a32e824` / `32b91e16-302a-4672-b55d-4e73bcedf54a`，Assets Git `40cb114e410e5f2afc886732eb146707edf8477b`。
- Production R2 current 为 `release-9cb02f77c06ee0535e7981a22b312373`，preview 为 `release-841a528f0086ce69f2f7a6f2d07c0999`；环境证据提交为 `290755749a0257ed720e7b2d26aa6b972c60aebb`，完整 verify 380/380。
- Production 终验事件 `2026-07-17T06:35:37.437Z` 已通过 API、D1 negative-write、三尺寸浏览器与 Pulse：完整图 553/214/261（概念星/谱系/跨学科），全隐藏 0/0，语文 143/60、运动能力泄漏 0，桌面和移动自动缩放 0.864→1.32、0.20→0.568；D1 前后 canonical digest 均为 `c4166f451f4b9529bf4221b56fb3017dc51aef7493a699553dc218287e42c430`，用户/运维表计数 0/0/3/2/0，Pulse 425/0。
- 第一方 console/page errors 为 0；Turnstile 的 2 个 opaque errors 与 5 个 warnings 均为第三方 challenge。任务 CLI 浏览器列表为空，root process 检查无任务 `cliDaemon.js`/profile，仅有 App-owned MCP；orphan dry-run 因平台 usage limit 拒绝提权，未绕过，也不得写成已运行通过。
- 私有加密档案已全量远端回读和隔离恢复；只引用 `backups/curriculum-atlas/private-archive/20260717T021000Z/archive-index.json`，不得记录密钥。

## 当前已知未决

- OCR 名义队列为 86 份／11,847 页，物理去重为 85 份／11,779 页。最新本机状态为 primary/audit 6,947、Vision 7,012、accepted display/citation 0；不得继续引用旧 50／8,690 口径，也不得把 v10 corpus 上线解释为 OCR 上线。
- 一页 `legacy-compendium-chemistry:84:paddle` 隔离，6,091 页仍 unresolved、783 页待图像复核、73 页待空白确认。逐页识别完成不是发布完成。
- DMITPro2 B-r1 因低内存门受控冻结在 1,259/3,182，0 failed、0 quarantine。新配置 B-r2 只有在 hash-bound seed lineage 实现、测试、predecessor receipt 与每页 hash/attempt 验签全部通过后才能创建；不得复制后再补证据。
- 当前深层 ontology 的 169 个节点主要属于语文；其它学科不能伪装为同等深度完成。
- 概念 observation 数据当前止于 2020；2022 corpus 文档和年代轨可见不等于已有 2022 概念观察。必须等 accepted OCR 和版本核对进入发布链后重建，不能由 UI 年代或文件年份推断。
- 两个 derived OCR PDF 的工具/参数谱系不完整，保持不可入队、不可发布。
- Companion 源码入口已登记，但新安装包需在真实 Android 设备验证后才能发布。
- Production R2/API、desktop/mobile 星图、D1 negative-write 与 Pulse 已由上述 append-only `verify` 事件独立核验；未来发布仍须产生新事件，不能沿用本次结论。

## 回滚边界

- Production Worker v7 `7d1766b2-32be-4ce1-9528-f6c69bb2a092` 与 D1 bookmark `0000002b-00002585-000050ab-8645885d977dc9bf5678e6cdf12b084f` 是耦合回滚；只回 Worker 会因 taxonomy schema 不兼容而 503。
- 正常 R2-only 回滚是取得新的 D1 publication owner/higher fence，再通过 coordinator 条件激活一份经过核验的 predecessor forward release；备份 pointer 只作取证，不直接覆盖或删除 `release/current.json`。stable-key fallback 删除属于另行审批且先冻结 publisher 的灾难恢复。
- Publisher 或 corpus importer 中断时先核远端 pointer/exact prefix/receipts，只从未提交边界继续；过期 owner 不可复用，必须由 higher-fence takeover 继续，禁止盲目重跑。
