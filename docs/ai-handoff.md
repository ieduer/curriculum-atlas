# AI / 开发者接手说明

## 必读顺序

1. `README.md`
2. `docs/original-goal-delivery-matrix.md`
3. `docs/architecture.md`
4. `docs/data-methodology.md`
5. `docs/ocr-quality.md`
6. `docs/data-model.md`
7. `docs/deployment.md`
8. `docs/operations.md`
9. `docs/project-asset-ledger.md`
10. `docs/project-data-integrity-audit-2026-07-16.md`
11. `docs/project-operations-ledger.md`
12. `/Users/ylsuen/CF/runbooks/bdfz_project_matrix_and_interdependencies.md`（仅 BDFZ 内部运维环境）

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
- 2026-07-22 本地候选已合并 2011 初中科学同版双扫描身份；候选 taxonomy 为 158 ordinary subject documents + 1 assessment subject。上行的 159 + 1 仍是尚未替换的线上 v10 快照。
- Production version/deployment 为 `28c7e6d4-1638-42bc-b371-bd8d24210b93` / `baa8a92f-ccc8-4972-b0ad-6d67876cdc84`，Assets Git `57487dc95481391cbcd40e0be0c92ee2d1ed8fdf`；preview 为 `2d107d38-cf31-49b6-82b1-20b32a32e824` / `32b91e16-302a-4672-b55d-4e73bcedf54a`，Assets Git `40cb114e410e5f2afc886732eb146707edf8477b`。
- Production R2 current 为 `release-9cb02f77c06ee0535e7981a22b312373`，preview 为 `release-841a528f0086ce69f2f7a6f2d07c0999`；环境证据提交为 `290755749a0257ed720e7b2d26aa6b972c60aebb`，完整 verify 380/380。
- Production 终验事件 `2026-07-17T06:35:37.437Z` 已通过 API、D1 negative-write、三尺寸浏览器与 Pulse：完整图 553/214/261（概念星/谱系/跨学科），全隐藏 0/0，语文 143/60、运动能力泄漏 0，桌面和移动自动缩放 0.864→1.32、0.20→0.568；D1 前后 canonical digest 均为 `c4166f451f4b9529bf4221b56fb3017dc51aef7493a699553dc218287e42c430`，用户/运维表计数 0/0/3/2/0，Pulse 425/0。
- 第一方 console/page errors 为 0；Turnstile 的 2 个 opaque errors 与 5 个 warnings 均为第三方 challenge。任务 CLI 浏览器列表为空，root process 检查无任务 `cliDaemon.js`/profile，仅有 App-owned MCP；orphan dry-run 因平台 usage limit 拒绝提权，未绕过，也不得写成已运行通过。
- 私有加密档案已全量远端回读和隔离恢复；只引用 `backups/curriculum-atlas/private-archive/20260717T021000Z/archive-index.json`，不得记录密钥。

## 当前已知未决

- 本地候选 OCR 名义队列为 86 份／11,903 页，扣除 68 页完全相同的劳动课标别名后为 85 个唯一实体／11,835 页。新增的是教育部 2003 年 144 页英语同作品扫描；它尚未进入既有远端冻结运行。线上 v10 与历史 OCR 运行回执仍引用其生成时的 86／11,847 分母；三组分母必须标明时间和目录指纹，不能混写。最新可比本机旧快照为 primary/audit 6,947、Vision 7,012、accepted display/citation 0；不得把候选 corpus 或 v10 上线解释为 OCR 上线。
- 资料恢复门已逐哈希核验 2 个固定损坏端点及一对一 quarantine、教育部 2017 RAR 的 21 个成员、16 份 2003 同作品扫描、5 份 Office 附件、149 份 canonical PDF 的物理页数和 86 条 OCR queue 输入。物理 2017 原始版使用恢复后的教育部原生文本 PDF；英语实验版改用教育部 144 页扫描进入后续 OCR；政治实验附件的一字冲突仍关闭引文。机器可读依据为 `data/source-recovery-proofs.json` 与其 72 小时在线收据 `data/source-recovery-online-receipt.json`；不得用题名匹配、`example.invalid`、404 或旧 ICTR URL 覆盖。ICTR 下载目录若仍返回 WAF 412，只能保留限域 interstitial 标记，附件本身仍须 200/MIME/magic/bytes/SHA 精确。
- 2026-07-17 legacy Mac 快照有一页 `legacy-compendium-chemistry:84:paddle` 隔离、6,091 页 unresolved、783 页待图像复核、73 页待空白确认；这些是带时间的旧分母，不是当前候选的实时完成数。逐页识别完成仍不等于发布完成。
- DMITPro2 的 B-r1 1,259/3,182 是不可变 predecessor。A2 已在一次受审 rearm 后启动，又因 operator monitor assertion 主动冻结；当前 output inode `45748776` 保留原 attempt 6 与原 authority/grant，worker/monitor/llama 均不得擅自重启。后续只能使用经独立审查的 same-attempt forward continuation，不得另发 grant、重置 attempt 或覆盖既有页/state。
- 当前深层 ontology 的 169 个节点主要属于语文；其它学科不能伪装为同等深度完成。
- 概念 observation 数据当前止于 2020；2022 corpus 文档和年代轨可见不等于已有 2022 概念观察。必须等 accepted OCR 和版本核对进入发布链后重建，不能由 UI 年代或文件年份推断。
- 两个 derived OCR PDF 的工具/参数谱系不完整，保持不可入队、不可发布。
- Companion 源码入口已登记，但新安装包需在真实 Android 设备验证后才能发布。
- Production R2/API、desktop/mobile 星图、D1 negative-write 与 Pulse 已由上述 append-only `verify` 事件独立核验；未来发布仍须产生新事件，不能沿用本次结论。

## 回滚边界

- Production Worker v7 `7d1766b2-32be-4ce1-9528-f6c69bb2a092` 与 D1 bookmark `0000002b-00002585-000050ab-8645885d977dc9bf5678e6cdf12b084f` 是耦合回滚；只回 Worker 会因 taxonomy schema 不兼容而 503。
- 正常 R2-only 回滚是取得新的 D1 publication owner/higher fence，再通过 coordinator 条件激活一份经过核验的 predecessor forward release；备份 pointer 只作取证，不直接覆盖或删除 `release/current.json`。stable-key fallback 删除属于另行审批且先冻结 publisher 的灾难恢复。
- Publisher 或 corpus importer 中断时先核远端 pointer/exact prefix/receipts，只从未提交边界继续；过期 owner 不可复用，必须由 higher-fence takeover 继续，禁止盲目重跑。
