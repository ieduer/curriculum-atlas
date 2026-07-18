# Curriculum Atlas 项目运维总账

<!-- curriculum-operations-ledger-snapshot {"schema_version":1,"action_log_line_cutoff":1397,"action_log_prefix_sha256":"7b715fe43a004174090a4f41be475dc4a74477235967d2683d4ca2efbb22a42c","included_event_count":419,"included_task_count":79,"included_event_sha256":"e175c21aad03bc7771f95dd9803b94704dbc0c8ba70249554760cf21bded58ea","included_through":"2026-07-17T06:35:37.437Z"} -->

生成时间：`2026-07-18T04:12:14.664Z`（America/Los_Angeles：`2026/07/17 21:12:14`）

覆盖区间：`2026-07-15T02:01:17.143Z` 至 `2026-07-17T06:35:37.437Z`；共 `79` 个任务、`419` 条运维事件。

本文件是项目内的可重建运维总账快照。事件明细来自 `/Users/ylsuen/CF/reports/agent_action_log.jsonl` 的 append-only 前 1397 行；前缀 SHA-256 为 `7b715fe43a004174090a4f41be475dc4a74477235967d2683d4ca2efbb22a42c`。本地数据数字来自生成时实际文件；Cloudflare 与远端 OCR 数字只引用带时间戳的最后一次只读核验。快照之后新增的日志属于待纳入事件，不会使已冻结发布提交失真；后来的状态不得回写覆盖历史，只能新增事件并在下一发布快照重新生成。

## 读数规则

- “OCR 已识别”只表示主 OCR 产物存在，不等于通过 Apple Vision、图像复核、同版在线核对、篇目/版次裁决、显示闸门或引文闸门。
- “本地完成”“预览已发布”“生产已发布”是三种不同状态；未注明部署 ID 的本地改动不得描述为上线。
- OCR 队列保留目录身份分母 86 份/11,847 页；精确 SHA-256 去重后的物理实体口径为 85 份/11,779 页。两种口径必须同时标明。
- D1、R2、Worker Assets 必须属于同一发布批次；任一层未对齐即视为未完成发布。
- 本文件包含完整历史事件，但旧事件的“当前”描述会被后续带时间戳事件 supersede；不能把旧进度相加到新进度。

## 原始目标与后续约束

### 立项目标

- 建成面向教师的“中国历年课程标准与考试评价演变”公共网站，覆盖资料检索、数据整理、产品设计、前后端、AI 研究、教师讨论、部署、验证和运维文档。
- 优先采用教育部、教育部课程教材研究所、教育考试机构和可信学术来源；保留来源机构、题名、版次、学段、学科、文件类型、日期、URL、文件哈希、页数、取得状态与再分发边界。
- 扫描件以原 PDF/页图为真值：主 OCR、独立 Apple Vision 见证、图像复核、目录/篇目定位、同篇同版在线文本和人工裁决相互印证；异版只能旁证稳定事实。
- 概念图必须呈现各学科历代关键概念、术语、能力、目标、内容、任务、学业质量与评价的演进，不把一份课标文件直接画成一颗星。
- Cloudflare Worker + Assets、D1、R2、统一用户中心、共享 APIS、Turnstile 与 Pulse 形成可部署、可回滚、可审计的生产体系。

### 迭代中追加的硬约束

- 利用本机 Downloads 中全部相关标准/汇编，但任何物理文件必须先登记身份、hash、版本关系和处置；不能因文件名相似直接合并或漏掉替代扫描。
- OCR 质量优先同时要求吞吐最大化；本机失败要立即隔离/恢复，DMITPro2 内层 Kali 可全负载运行，但远端只产生不可引文 staging。
- 星空是主视线区：学科显隐、年代、谱系、搜索、版本/资料、AI/讨论均围绕星图组织；删除冗余统计文字和重复 tabs。
- 学科数据必须使用受控分类：外语合并为显示组但保留语种身份，思想政治/思想品德/品德与社会/道德与法治建立历史谱系，信息科技/信息技术/通用技术归技术族；课程方案、学业质量、范围词、定向行走、美工等不得伪装成学科。
- 单学科选择后镜头自动适配；语文等学科必须下钻到三维目标、语言文字运用、阅读与鉴赏、能力要求、学业质量层级等可研究的底层概念。
- 任何仍不能由图像、OCR 和同版在线文本确认之处，由人工判断并保留不确定注释，显示/引文/语义发布继续 fail-closed。

## 生成时本地事实

| 层 | 当前事实 | 状态判定 |
|---|---|---|
| Git | branch `codex/ops-docs-release-refresh-20260717`; HEAD `290755749a0257ed720e7b2d26aa6b972c60aebb`; origin/main `290755749a0257ed720e7b2d26aa6b972c60aebb`; modified 8; untracked 1 | 生成器工作树含待提交文档变更；发布证据仍绑定已推送 commit；production environment evidence commit `290755749a0257ed720e7b2d26aa6b972c60aebb` |
| Catalog | 196 records；verified_online 176；local_verified_scan 12；metadata_only 6；citation_ready 101；ocr_review_pending 88 | checked-in generated snapshot |
| Ingest | 196 entries | 与 catalog ID 集合精确一致；物理文件另由 artifact registry 审计 |
| Asset registry | 245 PDF paths / 209 unique SHA-256；201 canonical、3 variant、2 derived、3 quarantine | 遗漏 hash、处置冲突、路径/校验和漂移均 fail closed |
| OCR queue | 名义 86 docs / 11847 pages；唯一实体 85 docs / 11779 pages；blocked 2 | 未完成且全部 fail-closed |
| Local OCR evidence | 主 OCR/audit 名义 6947/11847，唯一实体 6879/11779；Vision 名义 7012，唯一实体 6944；failed 1 | 2026-07-17T06:22:49.558Z 本机快照；显示/引文合格 0 |
| OCR publication | 0 accepted documents / 0 accepted pages | 0 页进入显示/引文发布 |
| Semantic quarantine | aliases 1；page controls 21 | unresolved controls override future page acceptance |
| Corpus release | `corpus-358471fcce862b2f0ae446fc`；196 documents / 16456 paragraphs / 16456 FTS / 6031 page gates / 16456 displayed / 0 accepted OCR / 91 chunks | preview 与 production evidence 均为 ready；OCR 正文仍未接入 |
| Taxonomy | 159 subject + 1 assessment subject + 16 courses + 20 scopes；12 facets / 28 exact query identities | schema 2；课程和范围不伪装成学科 |
| Concept graph | core 553 episodes / 475 edges；academic 195 works / 195 editions / 7821 occurrences / 5228 evidence | 五项 live asset byte parity 已由两端 release evidence 绑定 |
| Deep ontology | 169 nodes / 175 relations / 21 evidence anchors | 当前主要为语文深层模型；其他学科不可伪装已完成 |

### 本轮完成、保留边界与剩余阻断

1. **已登记**：三个替代扫描 `biology-b.pdf`、`math-b.pdf`、`politics-b.pdf` 已归为 `variant`；两个无可重放谱系的 OCR PDF 已归为 `derived`。五者都明确禁止入队和发布，不再作为“孤儿文件”静默存在。
2. **已隔离**：三个唯一的全零/无效下载载荷已归为 `quarantine`；文件魔数、大小和 SHA-256 发生变化时审计会要求重新裁决。
3. **已去重建模**：`moe-2022-17` 与 `ictr-6c6df9d121ac` 是同一 68 页实体，目录身份仍保留两条，物理 OCR/进度口径按 SHA-256 只计一次。
4. **已上线**：两端 D1 均通过 `0007_document_taxonomy_contract.sql`，Worker 均为 `2026.07.16-v10`，corpus `corpus-358471fcce862b2f0ae446fc` ready；corpus importer 的 91 个远端回执名称、hash 与 bytes 已闭环。
5. **已上线**：taxonomy 为 159 学科资料、1 考试学科、16 课程、20 范围，公开契约为 12 个展示分面与 28 个精确普通学科查询身份。
6. **R2 已原子激活**：preview `release-841a528f0086ce69f2f7a6f2d07c0999` 与 production `release-9cb02f77c06ee0535e7981a22b312373` 均在 evidence snapshot 之后由 append-only readback 事件证明；environment evidence 内的旧/空 pointer 只能解释为采集时快照，不能覆盖后续激活事实。
7. **私有备份已验证**：Final exact prefix is 15 objects and 3304581750 bytes; index GET is 8581 bytes SHA256 2ee9d8088dd89f77123c01da67916912f43c65c582c2ba6909fcb2904772bf2f; restored raw set is 246 of 246 files and 3245326023 bytes and OCR evidence is 81318 of 81318 files and 813926562 bytes with zero missing extra or problems; remote-readback contains exactly 15 files and 3304581750 bytes with zero partial or temp files; no browser session was opened and required dry-run found zero cliDaemon processes；本地索引为 `backups/curriculum-atlas/private-archive/20260717T021000Z/archive-index.json`，远端仅引用精确受控前缀，不记录密钥。
8. **OCR 仍阻断发布**：本机主 OCR/audit 6,947、Vision 7,012，但显示/引文 accepted 仍为 0；B-r1 冻结在 1,259/3,182。新并发配置不得直接复制旧输出或启动 B-r2，必须先落地并测试 hash-bound seed lineage，再以 predecessor receipt 验签。

## 最后一次外部核验快照

| 环境 | 已核验状态 | 回滚 / 阻断 |
|---|---|---|
| Production Worker | `28c7e6d4-1638-42bc-b371-bd8d24210b93` / `baa8a92f-ccc8-4972-b0ad-6d67876cdc84` / `2026.07.16-v10`；Assets Git `57487dc95481391cbcd40e0be0c92ee2d1ed8fdf`；health 200 | coupled rollback：D1 bookmark `0000002b-00002585-000050ab-8645885d977dc9bf5678e6cdf12b084f` + Worker `7d1766b2-32be-4ce1-9528-f6c69bb2a092`，仅在确认无后续用户写入后执行 |
| Preview Worker | `2d107d38-cf31-49b6-82b1-20b32a32e824` / `32b91e16-302a-4672-b55d-4e73bcedf54a` / `2026.07.16-v10`；Assets Git `40cb114e410e5f2afc886732eb146707edf8477b`；health 200 | rollback：preview D1 bookmark 与 Worker predecessor 由发布任务私有锚点保存 |
| D1 prod + preview | 两端 applied migrations 均为 `0001_initial.sql`、`0002_source_provenance_and_ocr_quality.sql`、`0003_online_verification.sql`、`0004_document_classifications.sql`、`0005_page_publication_gate.sql`、`0006_corpus_import_release.sql`、`0007_document_taxonomy_contract.sql`；pending 0；schema 3 / taxonomy 2 / page 1 | corpus 非 ready 或实时计数漂移时 API fail closed 503 |
| Corpus prod + preview | `corpus-358471fcce862b2f0ae446fc` ready；196/16456/16456/6031/16456/0/91 | documents / paragraphs / FTS / page gates / displayed / accepted OCR / chunks 必须精确相等 |
| Production R2（post-evidence） | Pointer stable across two reads at 388 bytes SHA256 5142166d000fbf82e6d0a9d135a5340ba3c9d77f3bed803967ad565ff8c2133a; manifest 107777 bytes SHA256 a6a15ea83cc58b1b84f5587a110c0fddeb414f24c77ff534507ea96868c03964; 17 unique release-prefixed objects total 546648 bytes match manifest and local sources with zero mismatch; API returns exact 55183-byte 196-entry ingest manifest SHA256 0f0fda279b10ef40011ea28477deb528ed5d45b7478dfd93a8b7bf6d0b1cb16e | 删除且只删除 `release/current.json` 可恢复 v10 stable-key fallback；不可变 release objects 保留 |
| Preview R2（post-evidence） | new pointer 388 bytes SHA256 65395a8b4fbca18f24aa36b37b54c72ae7e7b5f9071635a07e6285822cd0e12f; manifest 109499 bytes SHA256 7891b0989694070ade46686a8b26118fca1f74cc98b025b9252c1616f6277f3d; all 17 objects total 545536 bytes exact; ingest manifest 55183 bytes SHA256 0f0fda279b10ef40011ea28477deb528ed5d45b7478dfd93fc6e49ebd623c2463df296bc43fb73c5；authoritative correction：authoritative post-readback ingest manifest identity is 55183 bytes SHA256 0f0fda279b10ef40011ea28477deb528ed5d45b7478dfd93a8b7bf6d0b1cb16e; the immediately preceding log row contained a manual hash transcription error only | 恢复已备份 predecessor pointer；不可变 successor objects 可不引用保留 |
| Taxonomy | 159 subject + 1 assessment subject + 16 course + 20 scope；12 facets / 28 query identities | assessment/course/scope 保留身份，不进入普通学科精确筛选 |
| Local OCR | primary+audit 6947/11847；Vision 7012；accepted 0 | OCR 未完成、未上线；page publication 与 citation 保持 fail closed |
| DMITPro2 shard B-r1 | Read-only samples were 981131264 and 966483968 bytes MemAvailable, both below the one-GiB stop gate; B had 1259 of 3182 pages, zero failed pages and zero quarantine; explicit user-unit stop left MainPID zero and NRestarts zero while MemAvailable recovered to 2839844 kB | Implement audited seed contract and pass focused plus full local verification before commit；不得无 lineage 复制旧 state |
| Private encrypted archive | Final exact prefix is 15 objects and 3304581750 bytes; index GET is 8581 bytes SHA256 2ee9d8088dd89f77123c01da67916912f43c65c582c2ba6909fcb2904772bf2f; restored raw set is 246 of 246 files and 3245326023 bytes and OCR evidence is 81318 of 81318 files and 813926562 bytes with zero missing extra or problems; remote-readback contains exactly 15 files and 3304581750 bytes with zero partial or temp files; no browser session was opened and required dry-run found zero cliDaemon processes | index `backups/curriculum-atlas/private-archive/20260717T021000Z/archive-index.json`；远端精确前缀回滚需另行明确授权 |
| Production browser / API / Pulse | PASS: health 200 v10 Git57487dc schemas3/2/1 five bindings; corpus196/16456/16456/6031/91; taxonomy12 facets 28 identities; browser 1440x1000 1280x720 390x844 full553 lineage214 hide-all0 Chinese143/60 no movement leak no overflow; API negative gates 401/403; D1 user counts 0/0/3/2/0 and canonical digest c4166f451f4b9529bf4221b56fb3017dc51aef7493a699553dc218287e42c430 unchanged; Pulse tracked worker_analytics; task browser sessions closed and CLI list empty, root final ps found no task daemon/profile；event 2026-07-17T06:35:37.437Z；1440x1000 / 1280x720 / 390x844 均无 overflow；full 553 nodes / 214 lineage / 261 cross-subject，hide-all 0/0，Chinese 143/60，sports leak 0；auto zoom 0.864→1.32 与 0.20→0.568；deep links/workbenches/drag/zoom pass；D1 before=after 0/0/3/2/0，canonical digest c4166f451f4b9529bf4221b56fb3017dc51aef7493a699553dc218287e42c430；Pulse 425 requests / 0 errors；first-party console/page errors 0，Turnstile only 2 third-party opaque errors / 5 warnings；named sessions closed、CLI list empty、root ps 无 task daemon/profile，仅 App-owned MCP；orphan dry-run 因平台 usage limit 拒绝提权且未绕过 | 只读 QA 无状态回滚；下一 release 必须重新产生事件。现有 observation 数据止于 2020，accepted OCR 后才能重建 2022 概念观察 |
| Full governed verify | Immediately before bootstrap pointer was absent; release manifest production readiness true with zero blockers after 380 of 380 tests; publisher staged and verified 17 immutable objects then activated current pointer for release-9cb02f77c06ee0535e7981a22b312373; ingest manifest verified at 55183 bytes SHA256 0f0fda279b10ef40011ea28477deb528ed5d45b7478dfd93a8b7bf6d0b1cb16e | Git evidence commit `290755749a0257ed720e7b2d26aa6b972c60aebb` |
| Public registration | User Center、Nav、Portal、Companion source、Pulse 已登记；Pulse tracked | Companion 新 APK 因无真实 Android 设备验证而显式延期 |

## 生命周期里程碑

| 本地日期 | 里程碑 | 可证明结果 | 尚未完成 |
|---|---|---|---|
| 2026-07-14 | 立项、Cloudflare 资源创建、初版数据模型和公共站点 | 建立 Worker/D1/R2 preview+production、统一用户/AI/讨论边界；初始 Git `720d6ff` | 历史扫描 OCR、深层概念模型、完整视觉复刻 |
| 2026-07-14 夜间 | 生产发布、公共仓库与五面注册 | `curriculum.bdfz.net` 上线；GitHub `ieduer/curriculum-atlas`；User Center/Nav/Portal/Companion/Pulse 注册 | Companion 安装包真实设备 QA |
| 2026-07-14 至 07-15 | 全屏宇宙、概念星、学科/课程/范围重分类 | 文档星改为概念 episode；移除冗余 tabs；建立 subject/course/scope 边界与 12 个显示 facet | 全学科深层 ontology 与 OCR 证据接入 |
| 2026-07-15 | OCR 质量 supervisor 与故障恢复 | Paddle primary、Apple Vision blind witness、exact audit、页级 retry/quarantine、MuPDF 240 DPI、hash-bound provenance | 所有页仍不可自动引文 |
| 2026-07-15 | 深层语文 ontology 与生产 v7 | 生产部署 `ececd77`；概念层具有证据定位、版本/学段边界和 fail-closed relations | 当前本地模型已继续演化，生产不是最新 |
| 2026-07-15 夜间 | full-canvas preview v8 与本机 OCR hold | 预览 `b8344a9`；双栏轨道、学科聚焦自适应、移动工作台修复 | macOS syspolicyd/native runtime 与真实浏览器门阻断生产提升 |
| 2026-07-16 | DMITPro2 CUDA offload r1→r5 | 逐轮修复 venv realpath、共享 runtime 分类、owner lock、child timeout、sidecar/hash、PEG 单页失败隔离 | 远端结果仍仅 staging |
| 2026-07-16 | R6 72 卷回传与 6 页修复 | 72/5,483 whole-document 接收、receipt/rollback/idempotence 验证；Apple Vision evidence drain 完成 | 大部分页面仍未人工/在线同版裁决 |
| 2026-07-16 | page/semantic publication gates | 新增 page manifest、semantic quarantine、duplicate alias、外语/表格/精确字符规则；accepted=0 | migrations、D1/R2/Worker 三层尚未形成同一 release |
| 2026-07-16 至 07-17 | partial14 整卷重跑和全项目资产审计 | 资产主账、D1 release gate、R2 manifest 和 importer 原子性缺陷已收口；B-r1 因低内存冻结于 1,259/3,182 | hash-bound B-r2 seed lineage 与 OCR 质量闭环仍未完成 |
| 2026-07-17 | v10 taxonomy/corpus/R2 preview 与 production 发布 | 两端 D1 0001–0007、taxonomy schema 2、corpus 91/91 receipts、Worker v10、17-object versioned R2 release；production evidence commit `2907557`；production API/D1/browser/Pulse 终验通过 | OCR accepted 仍为 0；observation 数据止于 2020，全学科深层 ontology 仍须继续建设 |
| 2026-07-17 | 私有加密档案远端恢复演练 | 14 个 parts + index 共 15 objects/3,304,581,750 bytes；完整 GET/hash/decrypt/decompress/replay 零差异 | 不公开密钥；保留受控前缀与本地 index |

## Git 提交时间线

| Commit | 时间 | 说明 |
|---|---|---|
| `720d6ff96bbb` | 2026-07-14T21:54:08-07:00 | Launch curriculum standards evidence atlas |
| `02e7fa87f54b` | 2026-07-14T22:06:59-07:00 | Add public repository documentation |
| `b092c569bb24` | 2026-07-14T23:39:11-07:00 | Rebuild curriculum atlas as an evidence cosmos |
| `06795b1e85e7` | 2026-07-15T00:48:26-07:00 | feat: model curriculum history as concept stars |
| `fc4ce6549e49` | 2026-07-15T00:54:14-07:00 | fix: isolate monitored OCR graph candidates |
| `94cbbf027fd6` | 2026-07-15T02:12:27-07:00 | fix: classify curriculum subjects and harden OCR recovery |
| `5011eef3692c` | 2026-07-15T02:22:33-07:00 | fix: isolate preview integrations |
| `16b785fe6a94` | 2026-07-15T02:39:02-07:00 | docs: record subject taxonomy release |
| `2cd7d60696ad` | 2026-07-15T05:07:37-07:00 | feat(curriculum): separate course taxonomy and accelerate OCR |
| `4080dc234a64` | 2026-07-15T06:49:53-07:00 | Fix subject facets and harden OCR monitoring |
| `ececd77f1955` | 2026-07-15T08:25:39-07:00 | feat: add evidence-scoped curriculum concept ontology |
| `b8344a94140d` | 2026-07-15T19:31:35-07:00 | feat: focus curriculum cosmos and harden OCR runtime |
| `f464de029398` | 2026-07-16T00:00:31-07:00 | feat: harden remote curriculum OCR offload |
| `4d69a8f277a6` | 2026-07-16T19:35:10-07:00 | feat: publish release-governed curriculum atlas |
| `7bd37463a11a` | 2026-07-16T19:41:29-07:00 | fix: make release generators idempotent |
| `5796eb3ce4c3` | 2026-07-16T20:36:30-07:00 | fix: bound D1 corpus finalization |
| `6bacb4490278` | 2026-07-16T20:42:16-07:00 | chore: bind curriculum preview release evidence |
| `40cb114e410e` | 2026-07-16T21:22:22-07:00 | fix: persist curriculum taxonomy contract |
| `57487dc95481` | 2026-07-16T22:08:24-07:00 | chore: bind corrected preview release evidence |
| `290755749a02` | 2026-07-16T23:02:35-07:00 | chore: bind production release evidence |

## 任务索引

| 首次时间 UTC | 末次时间 UTC | 任务 | 事件 | 阶段 | 最后状态 / 未决 |
|---|---|---|---:|---|---|
| 2026-07-15T02:01:17.143Z | 2026-07-17T02:04:05.894Z | `curriculum-atlas-launch-20260714` | 3 | start, change, closeout | Migrations 0005 and 0006 plus first versioned R2 pointer activation remain blockers of the current release |
| 2026-07-15T04:04:59.710Z | 2026-07-17T02:04:05.923Z | `curriculum-atlas-online-verification` | 4 | change, closeout | Current 0005 and 0006 release gates are transferred to curriculum-atlas-full-release-20260716 |
| 2026-07-15T04:18:00.650Z | 2026-07-17T02:04:05.951Z | `curriculum-atlas-public-registration` | 3 | change, closeout | Companion entry is not public until the source is committed and an APK release passes the App runbook gate |
| 2026-07-15T04:24:25.637Z | 2026-07-17T02:04:05.980Z | `curriculum-atlas-production-deploy` | 3 | change, closeout | OCR publication remains fail-closed and belongs to the current full-release quality pipeline |
| 2026-07-15T05:01:22.432Z | 2026-07-15T05:01:22.514Z | `curriculum-atlas-public-launch` | 2 | verify, closeout | Complete the 8232-page adjudicated OCR queue before promoting remaining documents; publish Companion package only after real-device verification |
| 2026-07-15T05:05:49.137Z | 2026-07-15T05:08:57.868Z | `curriculum-atlas-github-publication` | 5 | start, change, verify, closeout | 49 OCR documents and 8232 pages remain fail-closed; Companion installation package awaits real-device QA |
| 2026-07-15T05:54:26.679Z | 2026-07-15T06:41:14.874Z | `curriculum-atlas-cosmos-redesign-and-ocr` | 5 | start, change, verify, closeout | 8232 OCR pages remain fail-closed; exact-edition corroboration and page 20 table reconstruction pending |
| 2026-07-15T06:51:30.646Z | 2026-07-15T07:57:19.209Z | `curriculum-concept-evolution-ocr-supervisor` | 6 | start, change, verify, closeout | automatic-monitor-candidates-never-promote-without-human-review |
| 2026-07-15T07:55:56.425Z | 2026-07-15T11:18:24.442Z | `curriculum-ocr-quality-supervisor` | 16 | start, change, verify, closeout | continue-with-legacy-compendium-plans-pages-1-32-on-next-unlocked-healthy-run-and-keep-forcing-32-page-batches-because-status-default-still-shows-64 |
| 2026-07-15T08:22:28.220Z | 2026-07-15T09:54:35.661Z | `curriculum-ocr-resilience-academic-model` | 8 | start, change, verify, closeout | Full OCR corpus remains pending and is now owned by curriculum-course-taxonomy-visual-ocr-throughput |
| 2026-07-15T08:42:27.406Z | 2026-07-15T09:06:02.077Z | `curriculum-subject-entity-boundary` | 4 | start, change, verify, closeout | parent-must-coordinate-migration-and-corpus-import-before-any-future-deploy |
| 2026-07-15T08:55:50.115Z | 2026-07-15T08:58:31.565Z | `curriculum-primary-artifact-self-heal` | 4 | start, change, verify, closeout | full-8232-page-ocr-corpus-remains-in-progress |
| 2026-07-15T09:03:45.090Z | 2026-07-15T09:04:28.457Z | `curriculum-hanyu-taxonomy-correction` | 4 | start, change, verify, closeout | none |
| 2026-07-15T09:09:02.807Z | 2026-07-17T02:04:06.012Z | `curriculum-subject-taxonomy-20260715` | 2 | change, closeout | Current generated graph revisions belong only to curriculum-atlas-full-release-20260716 |
| 2026-07-15T09:14:25.543Z | 2026-07-15T09:40:02.915Z | `curriculum-subject-taxonomy-fix` | 4 | change, verify, closeout | OCR corpus remains intentionally incomplete: 8207 pages pending and 15 pages fail-closed; observe 1h and 24h production error rate |
| 2026-07-15T09:54:35.563Z | 2026-07-15T12:10:29.308Z | `curriculum-course-taxonomy-visual-ocr-throughput` | 12 | start, change, verify, closeout | 8329-raw-pages-remain-estimated-center-36-point-40-hours-and-all-output-non-citable-until-editorial-review |
| 2026-07-15T10:17:24.161Z | 2026-07-15T10:24:00.475Z | `curriculum-course-taxonomy-model` | 4 | start, change, verify, closeout | parent-task-must-integrate-D1-health-preview-deploy-and-production-verification |
| 2026-07-15T11:35:49.400Z | 2026-07-15T11:37:11.415Z | `curriculum-controlled-subject-panel` | 4 | start, change, verify, closeout | parent-retains-deploy-and-cache-version-ownership |
| 2026-07-15T12:31:27.176Z | 2026-07-17T02:04:06.058Z | `curriculum-ocr-silent-acceleration` | 3 | start, change, closeout | Ongoing OCR ownership transfers to curriculum-atlas-full-release-20260716 |
| 2026-07-15T12:55:21.784Z | 2026-07-15T13:51:21.900Z | `curriculum-atlas-taxonomy-and-filter-fix` | 8 | start, change, verify, closeout | ocr-continues-silently-at-quality-preserving-three-way-profile-no-automatic-citation-promotion |
| 2026-07-15T14:22:40.717Z | 2026-07-17T02:04:06.105Z | `curriculum-deep-concept-ontology` | 5 | start, change, verify, closeout | Current dirty revisions of overlapping files belong only to curriculum-atlas-full-release-20260716 |
| 2026-07-15T15:06:36.640Z | 2026-07-15T15:27:31.574Z | `curriculum-atlas-deep-ontology` | 3 | change, closeout | OCR-continues-fail-closed_quality-table-20-indicators-await-visual-reconstruction |
| 2026-07-15T15:06:56.927Z | 2026-07-17T02:04:06.145Z | `curriculum-atlas-deep-ontology-deploy` | 3 | change, verify, closeout | The next release is owned by curriculum-atlas-full-release-20260716 |
| 2026-07-16T00:51:33.785Z | 2026-07-16T02:41:02.174Z | `curriculum-cosmos-focus-and-ocr-recovery-20260715` | 15 | start, verify, change, closeout | production promotion waits for real browser QA; OCR throughput is blocked by current desktop-session syspolicyd descriptor leak and remote offload waits for interactive BatchMode key installation; no OCR content is citation eligible |
| 2026-07-16T02:46:39.511Z | 2026-07-16T07:07:09.397Z | `curriculum-ocr-max-throughput-20260715` | 14 | start, change, verify, closeout | Commit is intentionally unpushed; remote output remains non-citable and excluded from website data until whole-document Mac and online verification gates pass |
| 2026-07-16T04:27:22.837Z | 2026-07-16T07:07:09.452Z | `curriculum-atlas-kali-ocr-offload` | 12 | change, verify, closeout | Pages40 and72 plus remaining corpus Mac witness audit online same-edition verification and import are pending |
| 2026-07-16T08:21:34.936Z | 2026-07-16T08:33:32.722Z | `curriculum-ocr-post-reboot-recovery-20260716` | 5 | start, change, verify, closeout | OCR continues with 3247 pages and two known fail-closed Russian pages; final corpus import and website update remain gated on full OCR and quality review; canonical report merge remains deferred until overlapping report ownership closes |
| 2026-07-16T13:14:41.870Z | 2026-07-17T02:04:06.186Z | `curriculum-r5-six-page-repair-20260716` | 10 | start, change, verify, closeout | Repair evidence remains non-citable until shared publication gates pass |
| 2026-07-16T13:27:22.521Z | 2026-07-16T14:03:23.998Z | `curriculum-remote-ocr-receiver-20260716` | 4 | start, change, verify, closeout | No D1 R2 Worker Pages report update deployment or real OCR production mutation occurred; parent retains responsibility for end-to-end import and site integration |
| 2026-07-16T14:06:12.095Z | 2026-07-16T14:21:37.550Z | `curriculum-page-publication-gate-20260716` | 4 | start, change, verify, closeout | Accepted OCR publication data remains deliberately empty; parent owns generation from reviewed OCR evidence, migration and corpus sequencing, deployment and live cache or browser verification |
| 2026-07-16T14:06:50.698Z | 2026-07-16T14:12:50.095Z | `curriculum-remote-ocr-status-contract-20260716` | 3 | start, verify, closeout | Real r6 validation remains a parent-owned execution step after the six repair receipts exist and both shard trees are staged locally |
| 2026-07-16T14:23:54.919Z | 2026-07-16T14:37:30.222Z | `curriculum-subject-facet-unification-20260716` | 4 | start, change, verify, closeout | Before production deployment bump the versioned app.js reference in index.html; grouped AI facets intentionally use one exact evidence-bounded AI request per evidenced canonical member and therefore consume the existing per-user quota proportionally |
| 2026-07-16T14:28:51.526Z | 2026-07-16T14:42:45.770Z | `curriculum-concept-publication-gate-20260716` | 4 | start, change, verify, closeout | Do not deploy stale checked-in concept artifacts; rebuild them after reviewed OCR pages are written to data page-publication-manifest json |
| 2026-07-16T14:37:30.767Z | 2026-07-16T14:50:03.566Z | `curriculum-remote-ocr-receiver-native-assets-20260716` | 4 | start, change, verify, closeout | Parent should rerun the staged 72-document dry-run and confirm expected 72 documents 5483 pages six repair pages and citation false before any apply |
| 2026-07-16T14:42:00.996Z | 2026-07-16T14:49:11.187Z | `curriculum-mobile-workbench-layout-20260716` | 5 | start, change, verify, closeout | Only parent-owned live browser QA asset build and deployment remain |
| 2026-07-16T14:44:33.653Z | 2026-07-16T14:56:01.786Z | `curriculum-backend-integrity-p2-20260716` | 4 | start, change, verify, closeout | Production behavior remains undeployed; deterministic language classification is conservative and future output formats should add tests before being exempted |
| 2026-07-16T14:52:47.011Z | 2026-07-16T15:18:38.020Z | `curriculum-partial-doc-whole-reprocess-20260716` | 5 | start, change, verify, closeout | Parent must keep the local OCR owner held when generating the final manifest and must dry-run the receiver against complete remote results before any authorized apply; legacy 72-document receipt remains separate and untouched |
| 2026-07-16T15:01:37.340Z | 2026-07-17T02:04:06.232Z | `curriculum-r6-vision-evidence-backfill-20260716` | 15 | start, change, verify, closeout | Evidence completion does not open citation or display; semantic publication gates remain authoritative |
| 2026-07-16T15:02:29.130Z | 2026-07-16T15:15:36.186Z | `curriculum-evidence-only-drain-20260716` | 4 | start, change, verify, closeout | Actual 5483-page evidence backfill remains parent-owned execution; existing 39 page Vision retry records are intentionally not cleared until each page succeeds and audits |
| 2026-07-16T15:11:37.812Z | 2026-07-16T15:49:05.985Z | `curriculum-partial14-private-r2-transfer-20260716` | 10 | start, change, verify, closeout | Transport complete; OCR quality and publication gates are intentionally outside this transfer closeout |
| 2026-07-16T15:20:05.395Z | 2026-07-16T15:22:33.528Z | `curriculum-vision-postexit-log-buffer-20260716` | 4 | start, change, verify, closeout | Actual evidence backfill remains paused pending successful one-page canary under the corrected implementation |
| 2026-07-16T15:20:21.258Z | 2026-07-17T02:04:06.511Z | `curriculum-partial14-remote-reprocess-20260716` | 19 | start, change, verify, closeout | Remote replacement remains staging-only and non-citable until whole-document witness audit online same-version verification and adjudication complete |
| 2026-07-16T15:26:03.954Z | 2026-07-16T15:27:41.477Z | `curriculum-vision-lazy-log-open-20260716` | 4 | start, change, verify, closeout | Actual evidence backfill remains paused pending a successful one-page canary |
| 2026-07-16T15:39:23.463Z | 2026-07-17T02:04:06.280Z | `curriculum-r6-corpus-quality-audit-20260716` | 2 | verify, closeout | Affected pages remain non-citable until exact gates pass |
| 2026-07-16T15:44:45.067Z | 2026-07-16T16:01:01.732Z | `curriculum-r6-semantic-quarantine-gate-20260716` | 4 | start, change, verify, closeout | No controlled foreign-language page is publication-ready; the explicit resolution requirements remain language-specific OCR, original-image comparison, row alignment for tables, same-edition online corroboration, and version-match verification |
| 2026-07-16T15:44:47.780Z | 2026-07-16T15:49:51.345Z | `curriculum-vision-launcher-isolation-20260716` | 4 | start, change, verify, closeout | Parent still owns any later supervised real Vision canary and operational rollout; this task intentionally did not clear retries, modify OCR cache, run real OCR, or touch remote resources |
| 2026-07-16T15:59:30.417Z | 2026-07-16T16:11:04.206Z | `curriculum-partial14-remote-monitor-source-20260716` | 4 | start, change, verify, closeout | Parent owns remote copy checksum readback systemd verify manual canary and optional timer activation; CPU live peak 96 C remains below warning 97 C but close enough to require monitoring |
| 2026-07-16T16:01:19.090Z | 2026-07-16T16:11:00.681Z | `curriculum-vision-launcher-discrepancy-20260716` | 4 | start, change, verify, closeout | Parent should run any real supervisor canary and later drain only through an unsandboxed approved command or external service. Provenance schema downgrade and the older fixed-delay signal test are report-only follow-ups |
| 2026-07-16T16:03:12.257Z | 2026-07-16T18:00:04.333Z | `curriculum-r6-foreign-language-online-source-mapping-20260716` | 4 | start, change, verify, closeout | Future release still requires language-specific OCR, source-image comparison, row alignment verification, version match verification and complete page-level adjudication under the existing semantic policy |
| 2026-07-16T16:12:09.120Z | 2026-07-16T16:17:22.523Z | `curriculum-partial14-remote-monitor-deploy-20260716` | 4 | start, change, verify, closeout | Long OCR run continues; temperature, memory, failures, stalls, restart counts and disk remain live operational risks monitored every two minutes |
| 2026-07-16T16:12:28.437Z | 2026-07-16T16:18:58.997Z | `curriculum-remote-first-book-quality-sample-20260716` | 3 | start, verify, closeout | The single sample proves structured-table risk but not its full-document incidence; expand targeted review across all pages in the common-character appendices and other table-heavy sections |
| 2026-07-16T16:23:04.920Z | 2026-07-16T16:27:51.392Z | `curriculum-moe-2011-semantic-preemptive-block-20260716` | 4 | start, change, verify, closeout | Future resolution must supply row_alignment_verified for page 49 and exact_character_verified for page 65 together with language-specific OCR source-image comparison same-edition online check and version match; until then both remain preemptively blocked |
| 2026-07-16T16:31:25.170Z | 2026-07-16T16:33:38.953Z | `curriculum-moe-2022-03-semantic-preemptive-block-20260716` | 4 | start, change, verify, closeout | Page 75 cannot resolve without row_alignment_verified and page 109 cannot resolve without running_header_removed, each together with language-specific OCR source-image comparison same-edition online check and version match |
| 2026-07-16T16:32:13.368Z | 2026-07-17T02:04:06.324Z | `curriculum-remote-second-book-quality-sample-20260716` | 2 | verify, closeout | The document remains blocked until page-level adjudication passes |
| 2026-07-16T16:35:15.762Z | 2026-07-16T16:42:37.394Z | `curriculum-ocr-review-queue-20260716` | 4 | start, change, verify, closeout | Parent may regenerate the derived queue after the evidence drain completes; queue generation intentionally never opens publication and conflicting duplicate evidence remains a hard error |
| 2026-07-16T16:39:26.793Z | 2026-07-17T02:04:06.358Z | `curriculum-online-exact-artifact-verification-20260716` | 2 | verify, closeout | Artifact identity alone is not independent text adjudication |
| 2026-07-16T16:45:56.149Z | 2026-07-17T02:04:06.390Z | `curriculum-atlas-ocr-review-queue` | 2 | verify, closeout | The queue has zero automatic acceptance |
| 2026-07-16T16:51:22.190Z | 2026-07-17T02:04:06.424Z | `curriculum-ocr-page-furniture-candidates-20260716` | 3 | start, change, closeout | No candidate rule is activated |
| 2026-07-16T17:01:59.686Z | 2026-07-16T17:13:16.970Z | `curriculum-yuwen-2022-candidate-layer-20260716` | 4 | start, change, verify, closeout | Nothing is unlocked: all nodes and relations remain non-citable/non-semantic until exact page evidence, image review and same-edition online text corroboration satisfy the future publication gates. |
| 2026-07-16T17:03:25.566Z | 2026-07-17T02:04:06.453Z | `curriculum-ocr-page-furniture-approval-20260716` | 3 | start, change, closeout | Header rules remain empty and no approval is activated |
| 2026-07-16T17:18:33.767Z | 2026-07-16T17:29:17.583Z | `curriculum-ocr-evidence-manifest-verifier-20260716` | 4 | start, change, verify, closeout | No verifier blocker. This proves evidence identity/completeness/freshness, not OCR semantic correctness or publication eligibility; image adjudication and same-edition online checks remain separate gates. |
| 2026-07-16T17:19:37.049Z | 2026-07-17T02:04:06.482Z | `curriculum-ocr-page-furniture-impact-preview-20260716` | 3 | start, change, closeout | Header conflicts and activation remain separately gated |
| 2026-07-16T17:20:27.082Z | 2026-07-16T17:34:33.359Z | `curriculum-yuwen-2022-online-claim-evidence-20260716` | 4 | start, change, verify, closeout | All claims remain publication_unlock false. Nine goals remain partial_conflicted; interpretive alignment remains normative false and semantic_relation_allowed false. |
| 2026-07-16T17:27:37.657Z | 2026-07-16T18:10:38.484Z | `curriculum-atlas-browser-qa-20260716` | 4 | start, change, verify, closeout | The site is not claimed deployed or complete; continued OCR and ontology expansion are still required before release |
| 2026-07-16T18:00:49.968Z | 2026-07-16T18:10:10.636Z | `curriculum-remote-ocr-intentional-pause-monitor-20260716` | 4 | start, change, verify, closeout | This closes only monitor semantics; OCR and publication work remain active and B must stay paused until a reviewed resource plan permits resume |
| 2026-07-16T18:11:46.099Z | 2026-07-16T18:11:51.615Z | `curriculum-atlas-progress-report-20260716` | 2 | change, closeout | Future checkpoints should append newer evidence rather than rewriting this timestamped snapshot |
| 2026-07-16T23:38:16.354Z | 2026-07-17T02:04:06.574Z | `curriculum-ocr-resume-accelerate-20260716` | 7 | start, change, verify, closeout | Publication remains blocked until OCR completion whole-document receipt dual witness online same-version verification and adjudication |
| 2026-07-17T00:25:26.877Z | 2026-07-17T01:13:20.503Z | `curriculum-atlas-asset-data-integrity-20260716` | 6 | start, change, verify, closeout | A later separately authorized preview window must apply 0005 and 0006 deploy the versioned reader import the corpus activate the R2 pointer and complete browser dependency verification before production can be considered |
| 2026-07-17T00:28:54.606Z | 2026-07-17T00:51:01.400Z | `curriculum-atlas-release-manifest-20260716` | 4 | start, change, verify, closeout | Do not publish until dist parity passes, 0005 and 0006 are applied, Worker reads versioned manifest pointer, environment snapshot is refreshed and full focused tests pass |
| 2026-07-17T01:21:35.286Z | 2026-07-17T06:35:37.437Z | `curriculum-atlas-full-release-20260716` | 28 | start, change, verify | Cloudflare Turnstile discussion challenge emitted two third-party opaque console errors and five warnings but zero first-party console errors or page errors; graph observation data currently ends in 2020 while 2022 corpus documents and era rail remain present, pending later accepted OCR concept rebuild |
| 2026-07-17T02:19:20.193Z | 2026-07-17T02:20:36.984Z | `curriculum-atlas-fixture-core-counts-20260716` | 4 | start, change, verify, closeout | Parent must run the full suite before staging |
| 2026-07-17T03:03:21.225Z | 2026-07-17T06:05:23.716Z | `curriculum-atlas-private-archive-upload-20260717` | 5 | start, change, verify, closeout | No archive verification defect remains; canonical report section is handed to parent for conflict-free merge; retain raw sources long term and OCR evidence through publication plus at least 90 days; review local preflight rebuilt and superseded evidence only under a future explicit retention cleanup, with no deletion now |
| 2026-07-17T03:06:27.162Z | 2026-07-17T03:18:04.643Z | `curriculum-chemistry-page84-adjudication-20260716` | 4 | start, change, verify, closeout | Keep citation and display false; resolution needs a same-edition 1941 authoritative witness or human image adjudication plus a validated repair path, preferably complete remote chemistry output received through the existing whole-document gate |
| 2026-07-17T03:28:14.758Z | 2026-07-17T03:35:48.492Z | `curriculum-atlas-staged-corpus-finalize-20260716` | 7 | start, change, verify, closeout | Parent must full verify commit push and perform the authorized preview finalize before R2 publication |
| 2026-07-17T03:52:36.862Z | 2026-07-17T04:08:26.895Z | `curriculum-atlas-taxonomy-contract-20260717` | 4 | start, change, verify, closeout | Regenerate corpus artifacts before reimport; collect new preview and production environment evidence instead of reusing historical receipts |
| 2026-07-17T03:55:25.375Z | 2026-07-17T03:57:15.823Z | `curriculum-ocr-watchdog-reference-audit-20260716` | 3 | start, verify, closeout | Do not restart or kickstart the healthy held watchdog for the stale log; archive or rotate stderr only in a separately authorized maintenance action if desired |
| 2026-07-17T04:11:48.489Z | 2026-07-17T04:11:48.593Z | `curriculum-atlas-inner-ssh-recovery-audit-20260716` | 2 | verify, closeout | Do not weaken host-key checking; if host keys legitimately rotate, verify out-of-band before replacing known_hosts entries |
| 2026-07-17T05:56:10.360Z | 2026-07-17T05:56:10.360Z | `curriculum-ocr-b-r2-lineage-implementation-20260717` | 1 | start | Implement audited seed contract and pass focused plus full local verification before commit |
| 2026-07-17T06:12:16.772Z | 2026-07-17T06:24:15.539Z | `curriculum-atlas-ops-docs-release-refresh-20260717` | 2 | start, change | Regenerate after final production browser D1 console and teardown verification event then run focused and repository checks before commit |

### 未以 closeout 结束的历史任务（4）

这些任务可能已被后续任务 supersede，但 action log 中没有对应 closeout。它们必须保留为治理缺口，不能静默当作已完成。

- `curriculum-course-taxonomy-visual-ocr-throughput`：最后阶段 `verify`，最后时间 `2026-07-15T12:10:29.308Z`；8329-raw-pages-remain-estimated-center-36-point-40-hours-and-all-output-non-citable-until-editorial-review
- `curriculum-atlas-full-release-20260716`：最后阶段 `verify`，最后时间 `2026-07-17T06:35:37.437Z`；Cloudflare Turnstile discussion challenge emitted two third-party opaque console errors and five warnings but zero first-party console errors or page errors; graph observation data currently ends in 2020 while 2022 corpus documents and era rail remain present, pending later accepted OCR concept rebuild
- `curriculum-ocr-b-r2-lineage-implementation-20260717`：最后阶段 `start`，最后时间 `2026-07-17T05:56:10.360Z`；Implement audited seed contract and pass focused plus full local verification before commit
- `curriculum-atlas-ops-docs-release-refresh-20260717`：最后阶段 `change`，最后时间 `2026-07-17T06:24:15.539Z`；Regenerate after final production browser D1 console and teardown verification event then run focused and repository checks before commit

## 截止点内完整 append-only 运维事件

事件子集 SHA-256：`e175c21aad03bc7771f95dd9803b94704dbc0c8ba70249554760cf21bded58ea`。以下 419 条按任务首次 UTC 排序，任务内事件再按 UTC 排序；逐条保留 scope、resources、evidence、rollback 和 unresolved。

<details><summary><code>curriculum-atlas-launch-20260714</code> · 3 events · 2026-07-15T02:01:17.143Z → 2026-07-17T02:04:05.894Z</summary>

Agents：`local-agent`、`codex-root`
Resources：`local:/Users/ylsuen/CF/curriculum-atlas; planned-domain:curriculum.bdfz.net; planned-worker:bdfz-curriculum-atlas; planned-d1:bdfz-curriculum-atlas; planned-r2:bdfz-curriculum-atlas-sources`、`D1:bdfz-curriculum-atlas`、`bdfz-curriculum-atlas-preview; R2:bdfz-curriculum-atlas-sources`、`bdfz-curriculum-atlas-sources-preview`、`bdfz-curriculum-atlas`、`bdfz-curriculum-atlas-preview`、`bdfz-curriculum-atlas-sources`

### 2026-07-15T02:01:17.143Z · start · local-agent

- Scope：new public teacher curriculum standards and assessment evolution site
- Resources：`local:/Users/ylsuen/CF/curriculum-atlas; planned-domain:curriculum.bdfz.net; planned-worker:bdfz-curriculum-atlas; planned-d1:bdfz-curriculum-atlas; planned-r2:bdfz-curriculum-atlas-sources`
- Evidence：Mandatory matrix, architecture, backend, user-first, user-system, Gemini, Companion, and canonical-report guidance reviewed; exact domain and repo names checked available; no production mutation yet.
- Rollback：Before shared-surface edits create checksum backups; Worker rollback to prior version; detach new custom domain; shared-file restore from task backup; D1/R2 additive resources retained, not deleted.
- Unresolved：Source licensing tiers and authenticated admin allowlist must remain fail-closed; 1h and 24h follow-up required after production launch.

### 2026-07-15T02:29:52.226Z · change · local-agent

- Scope：isolated Cloudflare resource creation
- Resources：`D1:bdfz-curriculum-atlas`、`bdfz-curriculum-atlas-preview; R2:bdfz-curriculum-atlas-sources`、`bdfz-curriculum-atlas-sources-preview`
- Evidence：Created two new WNAM D1 databases and two new Standard R2 buckets; preview strict dry-run passed with D1,R2,APIS,ASSETS bindings; no route/domain attached.
- Rollback：Resources are isolated and receive no traffic; do not delete as rollback. Stop deployment and leave resources dormant if preview fails.
- Unresolved：Production Turnstile widget and custom domain not yet configured; D1 migrations and corpus import pending.

### 2026-07-17T02:04:05.894Z · closeout · codex-root

- Scope：Close historical isolated Cloudflare resource creation and transfer all current D1 R2 Worker release ownership to curriculum-atlas-full-release-20260716
- Resources：`bdfz-curriculum-atlas`、`bdfz-curriculum-atlas-preview`、`bdfz-curriculum-atlas-sources`、`bdfz-curriculum-atlas-sources-preview`
- Evidence：The production and preview D1 and R2 pairs remain present and later public launch tasks deployed the site; no current source path remains uniquely owned by this historical task
- Rollback：Retain the additive isolated resources; the current release task owns D1 bookmarks R2 pointer state and Worker rollback anchors
- Unresolved：Migrations 0005 and 0006 plus first versioned R2 pointer activation remain blockers of the current release

</details>

<details><summary><code>curriculum-atlas-online-verification</code> · 4 events · 2026-07-15T04:04:59.710Z → 2026-07-17T02:04:05.923Z</summary>

Agents：`local-agent`、`codex-root`
Resources：`bdfz-curriculum-atlas-preview`、`D1-migrations-0002-0003`、`corpus-import`、`D1-Time-Travel`、`bdfz-curriculum-atlas-sources-preview`、`bdfz-curriculum-atlas-preview D1`

### 2026-07-15T04:04:59.710Z · change · local-agent

- Scope：preview-d1-migration-preparation
- Resources：`bdfz-curriculum-atlas-preview`、`D1-migrations-0002-0003`、`corpus-import`
- Evidence：Version-aware triad policy validated; corpus import changed to non-destructive upserts; build and typecheck passed
- Rollback：Export preview D1 before migration; D1 Time Travel; redeploy previous Worker version
- Unresolved：Preview still on schema v1 until migration and import complete

### 2026-07-15T04:05:49.326Z · change · local-agent

- Scope：preview-d1-rollback-anchor
- Resources：`bdfz-curriculum-atlas-preview`、`D1-Time-Travel`
- Evidence：Baseline 77 documents, 6505 paragraphs, 0 comments, schema v1; bookmark 00000002-0000078e-000050a9-6690eaf0be3ee7ae50700bbf03656224
- Rollback：wrangler d1 time-travel restore with recorded bookmark after explicit review
- Unresolved：D1 SQL export unavailable because database contains FTS5 virtual table

### 2026-07-15T04:10:20.274Z · change · local-agent

- Scope：preview-r2-and-worker-deploy
- Resources：`bdfz-curriculum-atlas-sources-preview`、`bdfz-curriculum-atlas-preview`
- Evidence：D1 schema v3; 195 documents; 16456 paragraphs; 1 verification with 5 evidence records; preview dry-run passed
- Rollback：Delete or restore versioned R2 metadata objects; redeploy previous Worker version; D1 Time Travel bookmark recorded
- Unresolved：Worker and R2 metadata not yet published at log time

### 2026-07-17T02:04:05.923Z · closeout · codex-root

- Scope：Close historical preview online-verification rollout after later production and preview releases superseded it
- Resources：`bdfz-curriculum-atlas-preview D1`、`bdfz-curriculum-atlas-sources-preview`
- Evidence：Historical preview schema corpus and source publication completed; current preview release state has been independently inventoried by the full release task
- Rollback：Use the full-release preview Time Travel bookmark Worker version and R2 pointer state
- Unresolved：Current 0005 and 0006 release gates are transferred to curriculum-atlas-full-release-20260716

</details>

<details><summary><code>curriculum-atlas-public-registration</code> · 3 events · 2026-07-15T04:18:00.650Z → 2026-07-17T02:04:05.951Z</summary>

Agents：`local-agent`、`codex-root`
Resources：`bdfz-user-center/src/index.js`、`bdfz-nav/sites.json`、`suen/allinone/index.html`、`bdfz-companion/constants/sites.ts`、`pulse/src/sites.js`、`bdfz-user-center`、`bdfz-nav`、`allinone`、`bdfz-companion`、`pulse`、`User Center SITE_REGISTRY`、`bdfz-nav sites.json`、`portal allinone`、`Pulse sites.js`、`bdfz-companion constants/sites.ts`

### 2026-07-15T04:18:00.650Z · change · local-agent

- Scope：five-surface-local-registration
- Resources：`bdfz-user-center/src/index.js`、`bdfz-nav/sites.json`、`suen/allinone/index.html`、`bdfz-companion/constants/sites.ts`、`pulse/src/sites.js`
- Evidence：Verified actual registration structures; stable siteKey curriculum; teacher_owned; Worker analytics; surgical additions only
- Rollback：Revert only curriculum-specific registry entries; no shared hub deployment before live parity and validation
- Unresolved：User Center and portal have pre-existing unrelated dirty changes; live deployment remains gated

### 2026-07-15T04:58:04.583Z · change · codex-root

- Scope：live-five-surface-registration
- Resources：`bdfz-user-center`、`bdfz-nav`、`allinone`、`bdfz-companion`、`pulse`
- Evidence：User Center 30d5f826, Nav 8c541509, Portal 96b72abe and Pulse 8cb651fb deployed; Companion source registration verified
- Rollback：User Center 1cadbeae; Nav 054ee260; Portal c1cd106c; Pulse bbffac20; remove only curriculum_atlas App source entry
- Unresolved：Companion APK release intentionally pending because no Android device was attached for required real-device verification

### 2026-07-17T02:04:05.951Z · closeout · codex-root

- Scope：Close completed shared web registration and transfer the remaining Companion source commit real-device verification and APK publication gate to curriculum-atlas-full-release-20260716
- Resources：`User Center SITE_REGISTRY`、`bdfz-nav sites.json`、`portal allinone`、`Pulse sites.js`、`bdfz-companion constants/sites.ts`
- Evidence：Four Web and operations registration surfaces are live; the stable curriculum entry is present in local Companion source only
- Rollback：Revert only the curriculum registration entry on each independently versioned surface if its product is withdrawn
- Unresolved：Companion entry is not public until the source is committed and an APK release passes the App runbook gate

</details>

<details><summary><code>curriculum-atlas-production-deploy</code> · 3 events · 2026-07-15T04:24:25.637Z → 2026-07-17T02:04:05.980Z</summary>

Agents：`local-agent`、`codex-root`
Resources：`bdfz-curriculum-atlas`、`bdfz-curriculum-atlas-sources`、`curriculum.bdfz.net`、`bdfz-curriculum-atlas-preview`、`bdfz-curriculum-atlas-sources-preview`、`bdfz-curriculum-atlas-D1`、`Turnstile`、`bdfz-curriculum-atlas Worker`、`production D1 and R2`

### 2026-07-15T04:24:25.637Z · change · local-agent

- Scope：production-d1-r2-worker
- Resources：`bdfz-curriculum-atlas`、`bdfz-curriculum-atlas-sources`、`curriculum.bdfz.net`
- Evidence：Production D1 contains only _cf_KV; pending migrations 0001-0003; prechange Time Travel bookmark 00000000-00000006-000050a9-06e95070b368d91c00f60607164f9526; full verification and dry-run passed
- Rollback：Restore D1 with recorded bookmark after review; rollback Worker to prechange version once created; R2 metadata is rebuildable
- Unresolved：Initial production Worker not yet created; anonymous discussion remains fail-closed until secrets are installed

### 2026-07-15T04:58:04.600Z · change · codex-root

- Scope：production-launch-and-security-bindings
- Resources：`bdfz-curriculum-atlas`、`bdfz-curriculum-atlas-preview`、`bdfz-curriculum-atlas-sources`、`bdfz-curriculum-atlas-sources-preview`、`bdfz-curriculum-atlas-D1`、`Turnstile`
- Evidence：Production schema v3 imported 195 documents and 16456 paragraphs; Worker d5435585 deployed with APIS and USER_CENTER bindings; managed Turnstile and HMAC secret names installed without values
- Rollback：Worker 0971d4ef; production D1 pre-migration Time Travel bookmark recorded; R2 metadata is idempotently rebuildable
- Unresolved：49 OCR queue documents and 8232 pages remain fail closed pending quality-first recognition and version-aware online verification

### 2026-07-17T02:04:05.980Z · closeout · codex-root

- Scope：Close the completed historical production launch and transfer the next versioned release to curriculum-atlas-full-release-20260716
- Resources：`curriculum.bdfz.net`、`bdfz-curriculum-atlas Worker`、`production D1 and R2`
- Evidence：The currently served production Worker remains the historical deployment and its prior rollback version is recorded by the full release inventory
- Rollback：Use the exact production Worker rollback version plus D1 Time Travel and preserved R2 pointer state captured by the full release task
- Unresolved：OCR publication remains fail-closed and belongs to the current full-release quality pipeline

</details>

<details><summary><code>curriculum-atlas-public-launch</code> · 2 events · 2026-07-15T05:01:22.432Z → 2026-07-15T05:01:22.514Z</summary>

Agents：`codex`
Resources：`curriculum.bdfz.net`、`bdfz-curriculum-atlas`、`bdfz-curriculum-atlas-db`、`bdfz-curriculum-atlas-sources`、`bdfz-user-center`、`bdfz-nav`、`suen`、`pulse`、`curriculum-atlas`、`cloudflare_business_audit_2026-05-23.md`、`agent_action_log.jsonl`

### 2026-07-15T05:01:22.432Z · verify · codex

- Scope：Production website, OCR corpus, online verification, AI citations, discussion auth, registrations, Pulse coverage
- Resources：`curriculum.bdfz.net`、`bdfz-curriculum-atlas`、`bdfz-curriculum-atlas-db`、`bdfz-curriculum-atlas-sources`、`bdfz-user-center`、`bdfz-nav`、`suen`、`pulse`
- Evidence：Health schema v3 healthy; 195 documents and 16456 paragraphs; 103 citation-ready; AI canary 10 of 10 paragraph citations covered; authenticated comment canary created then deleted; Pulse tracked_user_center; npm run verify passed; desktop and mobile QA passed
- Rollback：Worker and Pages version ids plus D1 Time Travel bookmarks are recorded in the canonical report and project operations manual
- Unresolved：49 runnable OCR documents totaling 8232 pages remain fail-closed; Companion real-device release remains pending because no Android device was attached

### 2026-07-15T05:01:22.514Z · closeout · codex

- Scope：Closeout and operational handoff
- Resources：`curriculum-atlas`、`cloudflare_business_audit_2026-05-23.md`、`agent_action_log.jsonl`
- Evidence：Production is live; canonical report and association index updated; task-owned Playwright session and local OCR inference server stopped; only protected Playwright MCP processes remain
- Rollback：Use documented Worker or Pages version rollback, D1 Time Travel bookmark, R2 backup bucket, and local git commit 720d6ff96bbb8f36b256e4308dba405fd6883df1
- Unresolved：Complete the 8232-page adjudicated OCR queue before promoting remaining documents; publish Companion package only after real-device verification

</details>

<details><summary><code>curriculum-atlas-github-publication</code> · 5 events · 2026-07-15T05:05:49.137Z → 2026-07-15T05:08:57.868Z</summary>

Agents：`codex`
Resources：`curriculum-atlas`、`GitHub ieduer namespace`、`README.md`、`.gitignore`、`.env.example`、`CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`、`LICENSE`、`docs/architecture.md`、`docs/data-model.md`、`docs/content-sources-and-rights.md`、`docs/ai-handoff.md`、`github.com/ieduer/curriculum-atlas`、`cloudflare_business_audit_2026-05-23.md`、`ieduer/curriculum-atlas`、`origin/main`、`GitHub`、`canonical report`

### 2026-07-15T05:05:49.137Z · start · codex

- Scope：Public repository readiness and publication
- Resources：`curriculum-atlas`、`GitHub ieduer namespace`
- Evidence：Original task requires a new public repository; repository name ieduer/curriculum-atlas is available; gh authenticated; pre-change Gitleaks scan clean
- Rollback：Keep local main as source of truth; remote creation can be archived or removed only after explicit review
- Unresolved：Repository documentation completeness and final verification pending

### 2026-07-15T05:05:49.217Z · change · codex

- Scope：Add public repository governance and handoff documentation
- Resources：`README.md`、`.gitignore`、`.env.example`、`CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`、`LICENSE`、`docs/architecture.md`、`docs/data-model.md`、`docs/content-sources-and-rights.md`、`docs/ai-handoff.md`
- Evidence：Added only public-safe documentation and secret-file ignore rules; PDFs, OCR cache, corpus SQL chunks, user data and secrets remain untracked
- Rollback：Revert the forthcoming documentation commit if public packaging is rejected
- Unresolved：Run full verification and secret scan before push

### 2026-07-15T05:08:57.707Z · change · codex

- Scope：Create and push public GitHub repository
- Resources：`github.com/ieduer/curriculum-atlas`、`cloudflare_business_audit_2026-05-23.md`
- Evidence：Created PUBLIC repository with homepage curriculum.bdfz.net; pushed main commit 02e7fa87f54b64859850bd177070a01c50172694; updated canonical report and association index
- Rollback：Local repository and deployed site remain independent; archive or delete the public repository only after explicit review
- Unresolved：OCR queue and Companion real-device release remain the only declared project follow-ups

### 2026-07-15T05:08:57.788Z · verify · codex

- Scope：Verify public repository state and publication safety
- Resources：`ieduer/curriculum-atlas`、`origin/main`
- Evidence：GitHub API reports PUBLIC visibility, main default branch and correct homepage; remote main equals local 02e7fa87f54b64859850bd177070a01c50172694; npm run verify passed; staged Gitleaks scan found no leaks; root files include license, security, contribution, changelog and handoff docs
- Rollback：Revert documentation commit or remove remote publication after explicit review; production Worker is unaffected
- Unresolved：None for repository publication

### 2026-07-15T05:08:57.868Z · closeout · codex

- Scope：Public repository handoff complete
- Resources：`curriculum-atlas`、`GitHub`、`canonical report`
- Evidence：Public source repository is available and synchronized; local worktree tracks origin/main; no original PDFs, OCR cache, user data or secrets were published
- Rollback：Git history provides code rollback; Cloudflare deployment rollback remains documented separately
- Unresolved：49 OCR documents and 8232 pages remain fail-closed; Companion installation package awaits real-device QA

</details>

<details><summary><code>curriculum-atlas-cosmos-redesign-and-ocr</code> · 5 events · 2026-07-15T05:54:26.679Z → 2026-07-15T06:41:14.874Z</summary>

Agents：`codex`
Resources：`curriculum-atlas`、`curriculum.bdfz.net`、`bdfz-curriculum-atlas-preview`、`bdfz-curriculum-atlas-D1`、`curriculum-atlas/public`、`curriculum-atlas/src/index.ts`、`curriculum-atlas/tests`、`curriculum-atlas/scripts/audit-ocr-witnesses.mjs`、`bdfz-curriculum-atlas`、`Pulse`、`OCR pages 10-20`、`canonical report`

### 2026-07-15T05:54:26.679Z · start · codex

- Scope：Leaf-site frontend rebuild, derived evolution graph, OCR continuation and quality verification
- Resources：`curriculum-atlas`、`curriculum.bdfz.net`、`bdfz-curriculum-atlas-preview`、`bdfz-curriculum-atlas-D1`
- Evidence：Live reference and local source inspection completed; repository clean at 02e7fa87; change is leaf UI/data presentation and does not alter User Center or APIS contracts
- Rollback：Create a backup branch before edits; preview first; production rollback to Worker d5435585-a107-494a-8d93-2fde6f381026; preserve D1 Time Travel bookmark before any production data write
- Unresolved：Final OCR batch size depends on measured per-page runtime and online verification availability

### 2026-07-15T06:15:29.756Z · change · codex

- Scope：Local curriculum-atlas frontend and OCR quality tooling; no production or D1 mutation yet
- Resources：`curriculum-atlas/public`、`curriculum-atlas/src/index.ts`、`curriculum-atlas/tests`、`curriculum-atlas/scripts/audit-ocr-witnesses.mjs`
- Evidence：Replaced marketing-page IA with full-viewport curriculum cosmos, in-map subject/concept controls, two merged bottom workspaces, independent Apple Vision witness audit; build, TypeScript and 10 tests pass
- Rollback：Restore backup/curriculum-cosmos-redesign-20260714 or revert local diff; production still at Worker d5435585-a107-494a-8d93-2fde6f381026
- Unresolved：Preview browser QA, historical OCR image adjudication, exact-edition online corroboration, and production deployment remain pending

### 2026-07-15T06:29:44.790Z · change · codex

- Scope：Preview and production curriculum-atlas Worker frontend deployment; no D1 or R2 data mutation
- Resources：`bdfz-curriculum-atlas-preview`、`bdfz-curriculum-atlas`、`curriculum.bdfz.net`
- Evidence：Preview e00cfe4d-f5b0-4965-87e4-262ba4d51b94 passed desktop/mobile and route QA; production deployed as 7709c041-c541-4baa-babb-3c7f29b18a30
- Rollback：Rollback production Worker to d5435585-a107-494a-8d93-2fde6f381026; no database rollback needed because D1 was unchanged
- Unresolved：Production live browser smoke, report update, Git commit/push and remaining OCR queue follow-up pending

### 2026-07-15T06:39:06.901Z · verify · codex

- Scope：Production curriculum-atlas UI, API, monitoring and bounded OCR witness audit
- Resources：`curriculum.bdfz.net`、`bdfz-curriculum-atlas`、`Pulse`、`OCR pages 10-20`
- Evidence：Production v3 health and bindings pass; source manifest ETag verified; desktop and 390x844 browser QA pass; subject hide 195 to 185; 10 tests pass; independent OCR audit is 0 auto, 4 manual, 2 blank-review and 5 fail-closed
- Rollback：Worker rollback d5435585-a107-494a-8d93-2fde6f381026; D1 and R2 unchanged
- Unresolved：8232-page OCR queue remains; exact 2001 compilation online edition not found; page 20 table requires cell reconstruction

### 2026-07-15T06:41:14.874Z · closeout · codex

- Scope：Curriculum atlas cosmos redesign, production release, OCR quality audit and documentation
- Resources：`curriculum-atlas`、`bdfz-curriculum-atlas`、`curriculum.bdfz.net`、`canonical report`
- Evidence：GitHub main b092c569bb242fd5404d14c4240920c14d1c7601; production 7709c041-c541-4baa-babb-3c7f29b18a30; tests and live browser/API/Pulse gates pass; task browser and llama OCR server closed; orphan cleanup dry-run matched zero cliDaemon processes
- Rollback：Worker d5435585-a107-494a-8d93-2fde6f381026; backup branch backup/curriculum-cosmos-redesign-20260714; no D1 or R2 rollback required
- Unresolved：8232 OCR pages remain fail-closed; exact-edition corroboration and page 20 table reconstruction pending

</details>

<details><summary><code>curriculum-concept-evolution-ocr-supervisor</code> · 6 events · 2026-07-15T06:51:30.646Z → 2026-07-15T07:57:19.209Z</summary>

Agents：`codex`、`Codex`
Resources：`curriculum-atlas`、`curriculum.bdfz.net`、`local OCR cache`、`curriculum-atlas/scripts`、`curriculum-atlas/public`、`curriculum-atlas/data`、`bdfz-curriculum-atlas-preview`、`bdfz-curriculum-atlas`、`pulse.bdfz.net`、`canonical-report`、`github-main`

### 2026-07-15T06:51:30.646Z · start · codex

- Scope：Leaf-site concept-evolution data contract, local OCR supervisor and concept-star prototype
- Resources：`curriculum-atlas`、`curriculum.bdfz.net`、`local OCR cache`
- Evidence：Repository clean at b092c569; live Worker v3 healthy; user corrected star grain from documents to subject-year concepts
- Rollback：Create backup branch before source edits; keep production at current Worker until preview concept gates pass; OCR cache is resumable and source PDFs immutable
- Unresolved：Full 8232-page OCR completion is long-running; concept publication remains page-evidence gated

### 2026-07-15T07:19:57.237Z · change · Codex

- Scope：local-curriculum-atlas
- Resources：`curriculum-atlas/scripts`、`curriculum-atlas/public`、`curriculum-atlas/data`
- Evidence：concept-episode-generator-and-fail-closed-supervisor-implemented
- Rollback：backup/curriculum-concept-graph-20260714
- Unresolved：production-not-deployed

### 2026-07-15T07:43:10.495Z · change · Codex

- Scope：curriculum-atlas-preview-deploy
- Resources：`bdfz-curriculum-atlas-preview`
- Evidence：verified-build-399-concept-episodes-15-tests-pass
- Rollback：redeploy-current-preview-version
- Unresolved：production-unchanged

### 2026-07-15T07:45:03.631Z · change · Codex

- Scope：curriculum-atlas-production-static-concept-map
- Resources：`curriculum.bdfz.net`、`bdfz-curriculum-atlas`
- Evidence：preview-ff9b914e-live-qa-pass-console-zero-errors
- Rollback：restore-worker-7709c041-c541-4baa-babb-3c7f29b18a30-d1-bookmark-preserved
- Unresolved：full-ocr-coverage-remains-in-progress

### 2026-07-15T07:57:19.180Z · verify · Codex

- Scope：production-concept-map-and-ocr-supervisor
- Resources：`curriculum.bdfz.net`、`bdfz-curriculum-atlas`、`bdfz-curriculum-atlas-preview`、`pulse.bdfz.net`
- Evidence：production-2c576476-v4-399-episodes-427-edges-1054-evidence-15-tests-console-zero-ocr-21-pages-zero-failures
- Rollback：restore-worker-7709c041-and-git-fc4ce65-no-d1-r2-restore
- Unresolved：8211-ocr-pages-and-editor-evidence-review-remain

### 2026-07-15T07:57:19.209Z · closeout · Codex

- Scope：concept-star-production-and-bounded-ocr-monitoring
- Resources：`curriculum-atlas`、`canonical-report`、`github-main`
- Evidence：preview-and-production-pass-nav-pulse-user-center-apis-regression-pass-worktree-clean-monitor-active
- Rollback：production-worker-7709c041-preview-prior-version-backup-branch-preserved
- Unresolved：automatic-monitor-candidates-never-promote-without-human-review

</details>

<details><summary><code>curriculum-ocr-quality-supervisor</code> · 16 events · 2026-07-15T07:55:56.425Z → 2026-07-15T11:18:24.442Z</summary>

Agents：`Codex`、`codex-automation`
Resources：`curriculum-atlas`、`.cache/ocr-production`、`.cache/ocr-witness`、`.cache/ocr-supervisor`、`.cache/concept-star-candidate`、`curriculum-atlas/.cache/ocr-supervisor`、`curriculum-atlas/.cache/ocr-witness/legacy-compendium-chinese`、`reports/cloudflare_business_audit_2026-05-23.md`、`current-run`、`retries`、`ocr-status`、`curriculum-atlas OCR supervisor and canonical report`、`curriculum-atlas/.cache/ocr-production`、`curriculum-atlas/.cache/ocr-witness`、`curriculum-atlas/.cache/concept-star-candidate`、`ocr-check`、`cloudflare_business_audit_2026-05-23.md`、`agent_action_log.jsonl`

### 2026-07-15T07:55:56.425Z · start · Codex

- Scope：bounded local OCR supervisor run for curriculum-atlas with one four-page batch maximum
- Resources：`curriculum-atlas`、`.cache/ocr-production`、`.cache/ocr-witness`、`.cache/ocr-supervisor`、`.cache/concept-star-candidate`
- Evidence：Initial ocr:status shows lock inactive, retries empty, disk 113.14 GiB free, checksums pinned, next batch legacy-compendium-chinese pages 1-4
- Rollback：No production rollback needed; local OCR outputs remain fail-closed and resumable; remove only this run's local cache artifacts after manual review if necessary
- Unresolved：Completed OCR pages remain non-citation and candidate concept graph stays unpublished until manual evidence review

### 2026-07-15T07:57:33.072Z · change · Codex

- Scope：one bounded local OCR batch attempted and failed in Apple Vision witness stage
- Resources：`curriculum-atlas/.cache/ocr-supervisor`、`curriculum-atlas/.cache/ocr-witness/legacy-compendium-chinese`、`reports/cloudflare_business_audit_2026-05-23.md`
- Evidence：npm run ocr:once -- --batch-pages 4 stopped at stage independent_apple_vision with nilError sidecars for pages 1-4 and no owned llama process; canonical report updated with fail-closed evidence
- Rollback：No production rollback; local retry/backoff state can be manually cleared only after investigating witness failure
- Unresolved：legacy-compendium-chinese now backs off until 2026-07-15T08:56:03.309Z and remains fail-closed

### 2026-07-15T07:57:33.085Z · verify · Codex

- Scope：post-run supervisor status verification
- Resources：`curriculum-atlas`、`current-run`、`retries`、`ocr-status`
- Evidence：Post-run ocr:status shows 49 documents 8232 pages total, 21 completed, 8211 pending, 0 failed pages, 21 witness pages, 4 witness error sidecars, 21 audited pages, gates 0/6/2/13, 4 reviewed pages, 0 citation eligible pages, disk 113.13 GiB, concept graph 396 verified citation-ready episodes plus 3 verified non-citation episodes and 0 OCR candidate episodes, next batch legacy-compendium-english pages 1-4
- Rollback：Verification only; no rollback required
- Unresolved：Apple Vision nilError root cause not yet isolated for legacy-compendium-chinese pages 1-4

### 2026-07-15T07:57:33.102Z · closeout · Codex

- Scope：bounded OCR automation run complete with fail-closed supervisor result
- Resources：`curriculum-atlas OCR supervisor and canonical report`
- Evidence：Exactly one bounded batch was attempted; supervisor remained unlocked and non-stalled afterward; no deploy, D1, R2, git commit, push, process kill or online text mutation occurred
- Rollback：Use existing local cache and report history only; do not alter production resources
- Unresolved：Next safe automation action is to investigate Apple Vision nilError or wait for post-backoff eligible batch; all OCR candidates remain non-citation

### 2026-07-15T10:57:21.667Z · start · codex-automation

- Scope：curriculum-atlas-local-ocr-bounded-16-page-batch
- Resources：`curriculum-atlas`、`.cache/ocr-supervisor`、`.cache/ocr-witness`
- Evidence：healthy-ocr-check-exit-0-no-lock-no-backoff-89-of-8690-pages-complete
- Rollback：no-production-state-change-local-cache-only-rerun-under-supervisor-contract
- Unresolved：batch-and-postrun-health-pending

### 2026-07-15T11:01:56.369Z · change · codex-automation

- Scope：curriculum-atlas-local-ocr-bounded-16-page-batch
- Resources：`curriculum-atlas`、`.cache/ocr-supervisor`、`.cache/ocr-witness`
- Evidence：legacy-compendium-history-pages-1-16-completed-page-failures-empty-audited-pages-1-16
- Rollback：local-cache-only-supervisor-state-can-be-retried-under-contract
- Unresolved：postrun-check-and-status-complete

### 2026-07-15T11:01:56.393Z · closeout · codex-automation

- Scope：curriculum-atlas-local-ocr-bounded-16-page-batch-complete
- Resources：`curriculum-atlas`、`.cache/ocr-supervisor`、`.cache/ocr-witness`
- Evidence：one-sandbox-external-16-page-batch-completed-cleanly-and-health-remains-0-healthy
- Rollback：no-production-state-change-local-cache-only
- Unresolved：maintain-10-minute-frequency-until-at-least-three-clean-16-page-batches-have-p95-under-five-minutes

### 2026-07-15T11:01:56.405Z · verify · codex-automation

- Scope：curriculum-atlas-local-ocr-bounded-16-page-batch
- Resources：`curriculum-atlas`、`.cache/ocr-supervisor`、`.cache/ocr-witness`
- Evidence：postrun-check-exit-0-status-healthy-105-of-8690-pages-complete-zero-witness-errors-zero-missing-zero-stale-disk-103-point-62-gib-next-batch-legacy-compendium-mathematics-1-4
- Rollback：no-production-state-change
- Unresolved：three-clean-16-page-batches-not-yet-met

### 2026-07-15T11:02:21.090Z · start · codex-automation

- Scope：curriculum-atlas-local-ocr-bounded-32-page-batch
- Resources：`curriculum-atlas`、`.cache/ocr-supervisor`、`.cache/ocr-production`、`.cache/ocr-witness`、`.cache/concept-star-candidate`
- Evidence：ocr-check-exit-0-ready-105-of-8690-pages-complete-zero-witness-errors-zero-stale-audits-next-batch-legacy-compendium-geography-pages-17-48
- Rollback：No production rollback needed; local OCR outputs remain fail-closed and resumable under supervisor state
- Unresolved：Batch runtime, post-run parity, and concept-candidate delta pending

### 2026-07-15T11:09:42.873Z · change · codex-automation

- Scope：curriculum-atlas-local-ocr-bounded-32-page-batch
- Resources：`curriculum-atlas/.cache/ocr-supervisor`、`curriculum-atlas/.cache/ocr-production`、`curriculum-atlas/.cache/ocr-witness`、`curriculum-atlas/.cache/concept-star-candidate`
- Evidence：sandbox-external-npm-run-ocr-once-batch-pages-32-completed-legacy-compendium-mathematics-pages-1-32-run-2026-07-15T11-02-40-554Z-96b3609b-page-failures-zero-audited-pages-32
- Rollback：No production rollback needed; local OCR outputs remain fail-closed and resumable under supervisor state
- Unresolved：Post-run parity and next-batch readiness verification pending

### 2026-07-15T11:09:42.887Z · verify · codex-automation

- Scope：curriculum-atlas-postrun-ocr-health
- Resources：`curriculum-atlas`、`ocr-check`、`ocr-status`
- Evidence：postrun-ocr-check-exit-0-ready-137-of-8690-pages-complete-zero-witness-errors-zero-missing-witness-zero-stale-audits-disk-102-point-39-gib-next-batch-legacy-compendium-physics-pages-1-32
- Rollback：Verification only; no rollback required
- Unresolved：Manual review gates increased but citation-eligible pages remain zero pending editorial review

### 2026-07-15T11:10:15.311Z · start · codex-automation

- Scope：curriculum-atlas-local-ocr-bounded-32-page-batch
- Resources：`curriculum-atlas`、`.cache/ocr-supervisor`、`.cache/ocr-production`、`.cache/ocr-witness`、`.cache/concept-star-candidate`
- Evidence：ocr-check-exit-0-ready-137-of-8690-pages-complete-zero-witness-errors-zero-stale-audits-next-batch-legacy-compendium-physics-pages-1-32
- Rollback：no-production-rollback-needed-local-cache-only-supervisor-state-resumable
- Unresolved：batch-runtime-postrun-parity-and-concept-candidate-delta-pending

### 2026-07-15T11:10:52.356Z · closeout · codex-automation

- Scope：curriculum-atlas-local-ocr-bounded-32-page-batch
- Resources：`curriculum-atlas`、`cloudflare_business_audit_2026-05-23.md`、`agent_action_log.jsonl`
- Evidence：single-allowed-32-page-batch-completed-cleanly-report-updated-and-postrun-health-remained-zero-failure-with-next-batch-legacy-compendium-physics-pages-1-32
- Rollback：No production rollback needed; local OCR state is resumable and all OCR output remains non-citation until editorial approval
- Unresolved：8553 pages remain pending and quality gates 50 manual 5 blank 82 fail-closed still require later review or additional OCR runs

### 2026-07-15T11:18:24.331Z · verify · codex-automation

- Scope：curriculum-atlas-postrun-ocr-health
- Resources：`curriculum-atlas`、`ocr-check`、`ocr-status`
- Evidence：postrun-ocr-check-exit-0-ready-169-of-8690-pages-complete-zero-witness-errors-zero-missing-witness-zero-stale-audits-zero-quarantine-disk-100-point-55-gib-citation-eligible-pages-zero-next-batch-legacy-compendium-plans-pages-1-32-concept-episodes-449-unchanged
- Rollback：verification-only-no-rollback-required
- Unresolved：manual-review-gates-58-and-unresolved-fail-closed-106-still-require-editorial-followup

### 2026-07-15T11:18:24.344Z · change · codex-automation

- Scope：curriculum-atlas-local-ocr-bounded-32-page-batch
- Resources：`curriculum-atlas/.cache/ocr-supervisor`、`curriculum-atlas/.cache/ocr-production`、`curriculum-atlas/.cache/ocr-witness`、`curriculum-atlas/.cache/concept-star-candidate`
- Evidence：sandbox-external-npm-run-ocr-once-batch-pages-32-completed-legacy-compendium-physics-pages-1-32-run-2026-07-15T11-10-28-113Z-1e1fd011-page-failures-zero-audited-pages-32-duration-428-point-787-seconds
- Rollback：no-production-rollback-needed-local-cache-only-supervisor-state-remains-resumable
- Unresolved：postrun-parity-review-gates-and-next-batch-readiness-verification-pending

### 2026-07-15T11:18:24.442Z · closeout · codex-automation

- Scope：curriculum-atlas-local-ocr-bounded-32-page-batch-complete
- Resources：`curriculum-atlas`、`.cache/ocr-supervisor`、`.cache/ocr-production`、`.cache/ocr-witness`、`.cache/concept-star-candidate`
- Evidence：one-sandbox-external-32-page-batch-completed-cleanly-and-health-remains-0-healthy-with-169-of-8690-pages-complete
- Rollback：no-production-state-change-local-cache-only-explicit-32-page-reruns-remain-available-under-supervisor-contract
- Unresolved：continue-with-legacy-compendium-plans-pages-1-32-on-next-unlocked-healthy-run-and-keep-forcing-32-page-batches-because-status-default-still-shows-64

</details>

<details><summary><code>curriculum-ocr-resilience-academic-model</code> · 8 events · 2026-07-15T08:22:28.220Z → 2026-07-15T09:54:35.661Z</summary>

Agents：`Codex`、`codex-root`、`codex-concept-schema`
Resources：`curriculum-atlas`、`local-ocr-cache`、`codex-automation`、`curriculum-atlas/scripts/vision-ocr-batch.swift`、`curriculum-atlas/scripts/lib/ocr-supervisor-state.mjs`、`curriculum-atlas/scripts/build-concept-evolution.mjs`、`curriculum-atlas/scripts/validate-concept-evolution.mjs`、`curriculum-atlas/data/concept-model-v2.json`、`curriculum-atlas/tests/concept-evolution-academic-schema.test.mjs`、`curriculum-atlas/docs`、`curriculum-atlas/scripts/ocr-supervisor.mjs`、`curriculum-atlas/package.json`、`curriculum-atlas/docs/ocr-quality.md`、`curriculum-atlas/docs/operations.md`、`codex-automation:curriculum-ocr-quality-supervisor`、`curriculum-atlas/public/data/concept-evolution.json`、`curriculum-atlas/public/data/concept-evolution-academic.json`、`curriculum-atlas/tests/concept-evolution.test.mjs`

### 2026-07-15T08:22:28.220Z · start · Codex

- Scope：local-ocr-supervisor-and-concept-schema-hardening
- Resources：`curriculum-atlas`、`local-ocr-cache`、`codex-automation`
- Evidence：current-failure-vision-nilError-chinese-pages-1-4-before-paddle-worktree-clean
- Rollback：backup-branch-before-edits-production-worker-and-d1-r2-unchanged
- Unresolved：fault-injection-and-academic-schema-validation-pending

### 2026-07-15T08:28:25.180Z · change · codex-root

- Scope：local-resilience-foundation
- Resources：`curriculum-atlas/scripts/vision-ocr-batch.swift`、`curriculum-atlas/scripts/lib/ocr-supervisor-state.mjs`
- Evidence：added-structured-vision-errors-and-pure-page-retry-health-helpers
- Rollback：backup/curriculum-ocr-resilience-20260715
- Unresolved：supervisor-integration-and-fault-tests-pending

### 2026-07-15T08:32:35.883Z · start · codex-concept-schema

- Scope：academic-concept-model-v2-local-only
- Resources：`curriculum-atlas/scripts/build-concept-evolution.mjs`、`curriculum-atlas/scripts/validate-concept-evolution.mjs`、`curriculum-atlas/data/concept-model-v2.json`、`curriculum-atlas/tests/concept-evolution-academic-schema.test.mjs`、`curriculum-atlas/docs`
- Evidence：delegated-disjoint-file-scope-worktree-has-parent-owned-vision-and-supervisor-lib-changes
- Rollback：backup/curriculum-ocr-resilience-20260715
- Unresolved：no-frontend-no-deploy-no-ocr-supervisor-edits

### 2026-07-15T08:46:04.989Z · change · codex-root

- Scope：local-ocr-recovery-and-monitoring
- Resources：`curriculum-atlas/scripts/ocr-supervisor.mjs`、`curriculum-atlas/scripts/lib/ocr-supervisor-state.mjs`、`curriculum-atlas/scripts/vision-ocr-batch.swift`、`curriculum-atlas/package.json`、`curriculum-atlas/docs/ocr-quality.md`、`curriculum-atlas/docs/operations.md`、`codex-automation:curriculum-ocr-quality-supervisor`
- Evidence：recovered-legacy-chinese-pages-1-4-and-rebuilt-pages-10-20-witnesses-health-exit-0
- Rollback：backup/curriculum-ocr-resilience-20260715
- Unresolved：concept-schema-v2-and-subject-taxonomy-fix-in-progress

### 2026-07-15T09:01:24.449Z · change · codex-concept-schema

- Scope：academic-concept-model-v2-local-only
- Resources：`curriculum-atlas/scripts/build-concept-evolution.mjs`、`curriculum-atlas/scripts/validate-concept-evolution.mjs`、`curriculum-atlas/data/concept-model-v2.json`、`curriculum-atlas/public/data/concept-evolution.json`、`curriculum-atlas/public/data/concept-evolution-academic.json`
- Evidence：academic-v2-core-full-split-controlled-subject-taxonomy-undifferentiated-senses-dual-ended-relations-and-explicit-coverage
- Rollback：backup/curriculum-ocr-resilience-20260715
- Unresolved：full-ocr-corpus-and-semantic-editorial-review-remain-in-progress

### 2026-07-15T09:01:24.486Z · verify · codex-concept-schema

- Scope：academic-concept-model-v2-local-only
- Resources：`curriculum-atlas/scripts/validate-concept-evolution.mjs`、`curriculum-atlas/tests/concept-evolution-academic-schema.test.mjs`、`curriculum-atlas/tests/concept-evolution.test.mjs`
- Evidence：concepts-validate-pass-academic-tests-11-of-11-combined-tests-15-of-15-core-2772436-bytes-under-4MiB
- Rollback：no-production-deploy-or-external-state-change
- Unresolved：semantic-sense-splitting-and-semantic-relations-require-editor-review

### 2026-07-15T09:01:24.516Z · closeout · codex-concept-schema

- Scope：academic-concept-model-v2-local-only
- Resources：`curriculum-atlas`
- Evidence：build-revision-cc542d24189a8bbb70ba2ee263a0ac70e8761490e7a376bb25226aa4ea9f3ac8-local-artifacts-verified
- Rollback：revert-task-scoped-diff-on-backup/curriculum-ocr-resilience-20260715
- Unresolved：no-deploy-performed-full-ocr-corpus-remains-in-progress

### 2026-07-15T09:54:35.661Z · closeout · codex-root

- Scope：parent-task-ownership-closeout
- Resources：`curriculum-atlas`、`local-ocr-cache`、`codex-automation`
- Evidence：Parent task completed: OCR health restored at 25/8232 with zero failures; academic model v2 and taxonomy release deployed; commits 94cbbf0, 5011eef, and 16b785f pushed; production Worker 805f3f0d verified
- Rollback：Code backup branch backup/curriculum-ocr-resilience-20260715 and Worker rollback 2c576476-b5fa-4789-a18e-7510b3fa3744
- Unresolved：Full OCR corpus remains pending and is now owned by curriculum-course-taxonomy-visual-ocr-throughput

</details>

<details><summary><code>curriculum-subject-entity-boundary</code> · 4 events · 2026-07-15T08:42:27.406Z → 2026-07-15T09:06:02.077Z</summary>

Agents：`codex-frontend-contract`
Resources：`curriculum-atlas/public/app.js`、`curriculum-atlas/public/atlas.js`、`curriculum-atlas/migrations/0004_document_classifications.sql`、`curriculum-atlas/scripts/build-corpus.mjs`、`curriculum-atlas/src`、`curriculum-atlas/tests`、`curriculum-atlas/scripts/document-classification.mjs`、`curriculum-atlas`

### 2026-07-15T08:42:27.406Z · start · codex-frontend-contract

- Scope：curriculum-atlas-consumer-and-persistence-classification
- Resources：`curriculum-atlas/public/app.js`、`curriculum-atlas/public/atlas.js`、`curriculum-atlas/migrations/0004_document_classifications.sql`、`curriculum-atlas/scripts/build-corpus.mjs`、`curriculum-atlas/src`、`curriculum-atlas/tests`
- Evidence：existing-subject-taxonomy-file-absent-concept-v2-owned-by-other-agent
- Rollback：backup/curriculum-ocr-resilience-20260715
- Unresolved：no-deploy-build-concept-evolution-and-concept-v2-excluded

### 2026-07-15T09:05:49.171Z · change · codex-frontend-contract

- Scope：curriculum-atlas-consumer-and-persistence-classification
- Resources：`curriculum-atlas/public/app.js`、`curriculum-atlas/public/atlas.js`、`curriculum-atlas/migrations/0004_document_classifications.sql`、`curriculum-atlas/scripts/document-classification.mjs`、`curriculum-atlas/scripts/build-corpus.mjs`、`curriculum-atlas/src`、`curriculum-atlas/tests`
- Evidence：concept-model-v2-single-taxonomy-source-canonical-D1-classification-and-strict-frontend-facets
- Rollback：backup/curriculum-ocr-resilience-20260715
- Unresolved：no-deploy-performed

### 2026-07-15T09:05:54.797Z · verify · codex-frontend-contract

- Scope：curriculum-atlas-consumer-and-persistence-classification
- Resources：`curriculum-atlas`
- Evidence：corpus-195-documents-175-subjects-20-scopes-0-unclassified-sqlite-migration-smoke-42-tests-tsc-build-wrangler-dry-run-pass
- Rollback：no-production-or-remote-state-change
- Unresolved：full-OCR-corpus-and-editorial-review-remain-parent-task

### 2026-07-15T09:06:02.077Z · closeout · codex-frontend-contract

- Scope：curriculum-atlas-consumer-and-persistence-classification
- Resources：`curriculum-atlas`
- Evidence：all-subject-compare-source-ai-selectors-now-canonical-subject-only-scope-stars-remain-visible
- Rollback：revert-task-scoped-diff-on-backup/curriculum-ocr-resilience-20260715
- Unresolved：parent-must-coordinate-migration-and-corpus-import-before-any-future-deploy

</details>

<details><summary><code>curriculum-primary-artifact-self-heal</code> · 4 events · 2026-07-15T08:55:50.115Z → 2026-07-15T08:58:31.565Z</summary>

Agents：`codex-ocr-review`
Resources：`curriculum-atlas/scripts/ocr-supervisor.mjs`、`curriculum-atlas/tests/ocr-supervisor-faults.test.mjs`

### 2026-07-15T08:55:50.115Z · start · codex-ocr-review

- Scope：local-ocr-supervisor-primary-recovery-selection
- Resources：`curriculum-atlas/scripts/ocr-supervisor.mjs`、`curriculum-atlas/tests/ocr-supervisor-faults.test.mjs`
- Evidence：delegated-fix-for-completed-page-content-or-result-hash-drift
- Rollback：backup/curriculum-ocr-resilience-20260715
- Unresolved：implementation-and-fault-tests-pending

### 2026-07-15T08:58:31.316Z · change · codex-ocr-review

- Scope：local-ocr-supervisor-primary-recovery-selection
- Resources：`curriculum-atlas/scripts/ocr-supervisor.mjs`、`curriculum-atlas/tests/ocr-supervisor-faults.test.mjs`
- Evidence：implemented-deep-validation-selection-in-normal-and-recover-modes-with-primary_recovery-and-force-reprocess-path
- Rollback：two-requested-files-only
- Unresolved：tests-and-health-check-complete

### 2026-07-15T08:58:31.447Z · verify · codex-ocr-review

- Scope：local-ocr-supervisor-primary-recovery-selection
- Resources：`curriculum-atlas/scripts/ocr-supervisor.mjs`、`curriculum-atlas/tests/ocr-supervisor-faults.test.mjs`
- Evidence：node-check-pass-node-test-7-of-7-pass-ocr-check-healthy-exit-0-stale-audit-0
- Rollback：no-production-deploy-or-data-mutation
- Unresolved：none

### 2026-07-15T08:58:31.565Z · closeout · codex-ocr-review

- Scope：local-ocr-supervisor-primary-recovery-selection
- Resources：`curriculum-atlas/scripts/ocr-supervisor.mjs`、`curriculum-atlas/tests/ocr-supervisor-faults.test.mjs`
- Evidence：completed-page-content-and-result-artifact-drift-now-self-heals-through-primary_recovery
- Rollback：revert-task-scoped-diff-on-backup/curriculum-ocr-resilience-20260715
- Unresolved：full-8232-page-ocr-corpus-remains-in-progress

</details>

<details><summary><code>curriculum-hanyu-taxonomy-correction</code> · 4 events · 2026-07-15T09:03:45.090Z → 2026-07-15T09:04:28.457Z</summary>

Agents：`codex-concept-schema`
Resources：`curriculum-atlas/data/concept-model-v2.json`、`curriculum-atlas/scripts/validate-concept-evolution.mjs`、`curriculum-atlas/tests/concept-evolution-academic-schema.test.mjs`、`curriculum-atlas/scripts/build-concept-evolution.mjs`、`curriculum-atlas/public/data/concept-evolution.json`、`curriculum-atlas/public/data/concept-evolution-academic.json`、`curriculum-atlas`

### 2026-07-15T09:03:45.090Z · start · codex-concept-schema

- Scope：local-taxonomy-only
- Resources：`curriculum-atlas/data/concept-model-v2.json`、`curriculum-atlas/scripts/validate-concept-evolution.mjs`、`curriculum-atlas/tests/concept-evolution-academic-schema.test.mjs`
- Evidence：catalog-identifies-hanyu-as-2019-gaokao-assessment-subject
- Rollback：backup/curriculum-ocr-resilience-20260715
- Unresolved：rebuild-and-tests-pending

### 2026-07-15T09:04:28.396Z · change · codex-concept-schema

- Scope：local-taxonomy-only
- Resources：`curriculum-atlas/data/concept-model-v2.json`、`curriculum-atlas/scripts/build-concept-evolution.mjs`、`curriculum-atlas/scripts/validate-concept-evolution.mjs`、`curriculum-atlas/tests/concept-evolution-academic-schema.test.mjs`
- Evidence：hanyu-reclassified-as-independent-assessment-subject-and-comprehensive-practical-activity-given-independent-lineage
- Rollback：backup/curriculum-ocr-resilience-20260715
- Unresolved：none

### 2026-07-15T09:04:28.427Z · verify · codex-concept-schema

- Scope：local-taxonomy-only
- Resources：`curriculum-atlas/public/data/concept-evolution.json`、`curriculum-atlas/public/data/concept-evolution-academic.json`
- Evidence：concepts-validate-pass-academic-tests-11-of-11-core-2774210-bytes
- Rollback：no-production-deploy-or-external-state-change
- Unresolved：none

### 2026-07-15T09:04:28.457Z · closeout · codex-concept-schema

- Scope：local-taxonomy-only
- Resources：`curriculum-atlas`
- Evidence：build-revision-5ee77288611c986578146165ba4df9325cef971ac9f0d0b59140e132feb6950c
- Rollback：revert-task-scoped-diff-on-backup/curriculum-ocr-resilience-20260715
- Unresolved：none

</details>

<details><summary><code>curriculum-subject-taxonomy-20260715</code> · 2 events · 2026-07-15T09:09:02.807Z → 2026-07-17T02:04:06.012Z</summary>

Agents：`codex-root`
Resources：`curriculum-atlas source`、`migration 0004`、`concept graph core and academic data`、`curriculum-atlas taxonomy source`

### 2026-07-15T09:09:02.807Z · change · codex-root

- Scope：Local curriculum taxonomy, API, frontend and rollback compatibility hardening
- Resources：`curriculum-atlas source`、`migration 0004`、`concept graph core and academic data`
- Evidence：195 catalog rows classify to 175 subject and 20 scope with zero unclassified; cache generations aligned; classification is additive child schema 1
- Rollback：backup/curriculum-ocr-resilience-20260715
- Unresolved：Production and preview not yet mutated

### 2026-07-17T02:04:06.012Z · closeout · codex-root

- Scope：Close predecessor taxonomy task after the production taxonomy fix and current facet invariants superseded it
- Resources：`curriculum-atlas taxonomy source`、`migration 0004`
- Evidence：Historical taxonomy commits are frozen and current taxonomy and facet focused tests pass
- Rollback：Use the repository commits recorded by the successor taxonomy task
- Unresolved：Current generated graph revisions belong only to curriculum-atlas-full-release-20260716

</details>

<details><summary><code>curriculum-subject-taxonomy-fix</code> · 4 events · 2026-07-15T09:14:25.543Z → 2026-07-15T09:40:02.915Z</summary>

Agents：`codex-root`
Resources：`bdfz-curriculum-atlas-preview`、`D1-preview`、`Worker-preview`、`curriculum.bdfz.net`、`bdfz-curriculum-atlas`、`D1-production`、`Pulse`、`User-Center`、`Nav`、`concept-model-v2`、`OCR-supervisor`、`canonical-report`

### 2026-07-15T09:14:25.543Z · change · codex-root

- Scope：curriculum-atlas-preview
- Resources：`bdfz-curriculum-atlas-preview`、`D1-preview`、`Worker-preview`
- Evidence：Prechange Worker ff9b914e; D1 schema 3 with 195 documents; Time Travel bookmark 0000000b-00000000-000050a9-5a56f437edf35dfb0d55914e40acd99a; full export unavailable because D1 contains FTS5 virtual tables
- Rollback：Rollback preview Worker to ff9b914e; restore preview D1 from recorded Time Travel bookmark only if required
- Unresolved：Preview migration and browser verification pending

### 2026-07-15T09:26:23.077Z · change · codex-root

- Scope：curriculum-atlas-production
- Resources：`curriculum.bdfz.net`、`bdfz-curriculum-atlas`、`D1-production`
- Evidence：Prechange Worker 2c576476; D1 schema 3 with 195 documents, 0 comments, 0 reports, 2 AI citation logs; Time Travel bookmark 00000024-00000000-000050a9-d19c9e4a30d2b99a4a3c07e7336d6761; preview v5 passed API and browser gates
- Rollback：Rollback Worker to 2c576476; additive classification table is v4-compatible; restore D1 only if required from recorded Time Travel bookmark
- Unresolved：Production migration, import, deploy and live regression pending

### 2026-07-15T09:39:57.722Z · verify · codex-root

- Scope：curriculum-atlas-production
- Resources：`curriculum.bdfz.net`、`bdfz-curriculum-atlas`、`D1-production`、`Pulse`、`User-Center`、`Nav`
- Evidence：Worker 805f3f0d-ec68-49e1-8cff-cd1afa37910b reports v5; D1 classification 195/195 with 175 subject, 20 scope, 0 unclassified; 42 tests and desktop/mobile browser checks passed with zero console errors; Pulse tracked 154 requests with 0 errors; OCR healthy at 25/8232 pages with 0 failed
- Rollback：Worker version 2c576476-b5fa-4789-a18e-7510b3fa3744; D1 prechange Time Travel bookmark 00000024-00000000-000050a9-d19c9e4a30d2b99a4a3c07e7336d6761
- Unresolved：8207 OCR pages pending; 15 pages remain fail-closed; 1h and 24h error-rate observation follow-up remains

### 2026-07-15T09:40:02.915Z · closeout · codex-root

- Scope：curriculum-atlas-production-complete
- Resources：`curriculum.bdfz.net`、`bdfz-curriculum-atlas`、`D1-production`、`concept-model-v2`、`OCR-supervisor`、`canonical-report`
- Evidence：Subject/scope classification is live and fail-closed; main pushed at 16b785f; production health is v5 with 195/195 classifications and all bindings true; OCR supervisor ACTIVE every 10 minutes; task browser closed and no cliDaemon orphan matched
- Rollback：Rollback Worker to 2c576476-b5fa-4789-a18e-7510b3fa3744; additive D1 table remains v4-compatible; use prechange Time Travel bookmark only if database rollback is required
- Unresolved：OCR corpus remains intentionally incomplete: 8207 pages pending and 15 pages fail-closed; observe 1h and 24h production error rate

</details>

<details><summary><code>curriculum-course-taxonomy-visual-ocr-throughput</code> · 12 events · 2026-07-15T09:54:35.563Z → 2026-07-15T12:10:29.308Z</summary>

Agents：`codex-root`、`Codex`
Resources：`curriculum-atlas`、`local-ocr-cache`、`codex-automation`、`data/local-compendia.json`、`data/catalog.json`、`data/ocr-queue.json`、`.cache/sources/local-compendia/chemistry.pdf`、`scripts/ocr-supervisor.mjs`、`bdfz-curriculum-atlas-preview`、`D1-preview`、`Worker-preview`、`Playwright`、`curriculum.bdfz.net`、`bdfz-curriculum-atlas`、`D1-production`、`data/ingest-manifest.json`、`bdfz-curriculum-atlas-sources`、`bdfz-curriculum-atlas-sources-preview`、`curriculum-atlas/.cache/ocr-supervisor`、`curriculum-atlas/.cache/ocr-production`、`curriculum-atlas/.cache/ocr-witness`、`bdfz-curriculum-atlas-preview.bdfz.workers.dev`、`Pulse`、`User-Center`、`Nav`、`curriculum-ocr-quality-supervisor`、`canonical-report`、`curriculum-atlas-local-ocr`

### 2026-07-15T09:54:35.563Z · start · codex-root

- Scope：curriculum-atlas-leaf-data-frontend-local-ocr
- Resources：`curriculum-atlas`、`local-ocr-cache`、`codex-automation`
- Evidence：Production v5 is healthy; git HEAD 16b785f clean; OCR 25/8232 healthy but scheduler blocked by stale unclosed ownership record; user requested three-tier taxonomy, visual changes, and throughput diagnosis
- Rollback：Backup branch before code edits; production Worker and D1 unchanged until preview verification
- Unresolved：Taxonomy audit, 16-page throughput canary, frontend implementation, preview and production verification pending

### 2026-07-15T10:20:04.356Z · change · Codex

- Scope：curriculum-atlas-local-data-and-ocr
- Resources：`data/local-compendia.json`、`data/catalog.json`、`data/ocr-queue.json`、`.cache/sources/local-compendia/chemistry.pdf`、`scripts/ocr-supervisor.mjs`
- Evidence：Chemistry scan cover title CIP ISBN page count and SHA-256 verified; queue rebuilt to 50 documents and 8690 pages; sandbox-external 240-dpi Apple Vision recovery completed page 3 with no page failures
- Rollback：Restore backup branch backup/curriculum-course-taxonomy-visual-20260715-v6 and remove only the newly added chemistry cache entry/file if rollback is required
- Unresolved：Pages 1-2 remain quarantined from sandbox-induced Vision failures; recover with explicit retry-failed after candidate and taxonomy changes stabilize

### 2026-07-15T10:37:45.723Z · change · codex-root

- Scope：curriculum-atlas-preview-prechange
- Resources：`bdfz-curriculum-atlas-preview`、`D1-preview`、`Worker-preview`
- Evidence：prechange-worker-cf7aed3f-and-d1-timetravel-bookmark-0000000b-00000138-000050a9-8e769cb47aeb6c7e085c3e8cf51c84f8
- Rollback：rollback-preview-worker-to-cf7aed3f-and-restore-preview-d1-from-recorded-bookmark-if-required
- Unresolved：preview-import-deploy-and-live-browser-verification-pending

### 2026-07-15T10:59:11.929Z · verify · codex-root

- Scope：curriculum-atlas-preview
- Resources：`bdfz-curriculum-atlas-preview`、`D1-preview`、`Worker-preview`、`Playwright`
- Evidence：v6-health-196-of-196-160-subject-16-course-20-scope-zero-unclassified-16456-paragraphs-29-facets-452-episodes-desktop-mobile-zero-console-errors-no-overflow-and-subject-hide-count-changed-452-to-414
- Rollback：preview-worker-cf7aed3f-and-d1-bookmark-0000000b-00000138-000050a9-8e769cb47aeb6c7e085c3e8cf51c84f8
- Unresolved：production-deploy-and-live-regression-pending

### 2026-07-15T10:59:30.827Z · change · codex-root

- Scope：curriculum-atlas-production-prechange
- Resources：`curriculum.bdfz.net`、`bdfz-curriculum-atlas`、`D1-production`
- Evidence：prechange-worker-805f3f0d-and-d1-bookmark-00000024-00000138-000050a9-92472a9486e03e820e754bf9815e5747-with-195-documents-0-comments-0-reports-2-ai-logs
- Rollback：rollback-worker-to-805f3f0d-and-restore-d1-from-fresh-bookmark-only-if-required
- Unresolved：production-corpus-import-deploy-and-live-regression-pending

### 2026-07-15T11:07:47.479Z · change · codex-root

- Scope：curriculum-atlas-production-v6
- Resources：`curriculum.bdfz.net`、`bdfz-curriculum-atlas`、`D1-production`
- Evidence：production-D1-import-67-of-67-196-documents-16456-paragraphs-160-subject-16-course-20-scope-zero-unclassified-comments-reports-ai-logs-preserved-0-0-2-and-worker-version-cefceec5-deployed
- Rollback：worker-805f3f0d-and-D1-bookmark-00000024-00000138-000050a9-92472a9486e03e820e754bf9815e5747
- Unresolved：live-API-browser-dependency-regression-and-documentation-pending

### 2026-07-15T11:18:55.054Z · change · codex-root

- Scope：curriculum-atlas-source-metadata
- Resources：`data/ingest-manifest.json`、`bdfz-curriculum-atlas-sources`、`bdfz-curriculum-atlas-sources-preview`
- Evidence：source-fetch-verified-187-of-196-and-R2-readback-196-entries-including-legacy-compendium-chemistry-with-verified-SHA-and-size
- Rollback：republish-previous-ingest-manifest-and-catalog-metadata-from-git-if-required
- Unresolved：64-page-OCR-canary-and-continuous-drain-validation-pending

### 2026-07-15T11:51:54.541Z · change · codex-root

- Scope：curriculum-atlas-ocr-continuous-drain
- Resources：`curriculum-atlas/.cache/ocr-supervisor`、`curriculum-atlas/.cache/ocr-production`、`curriculum-atlas/.cache/ocr-witness`、`codex-automation`
- Evidence：64-page-canary-run-2026-07-15T11-18-42-775Z-1a206bf2-completed-64-primary-64-vision-64-audits-zero-failures-duration-1238-point-156-seconds-and-singleton-drain-started-next-batch-within-one-second
- Rollback：stop-only-the-recorded-drain-owner-and-resume-bounded-ocr-once-under-supervisor-lock
- Unresolved：8457-pages-remained-at-canary-closeout-and-all-OCR-output-remains-fail-closed-pending-version-aware-editorial-review

### 2026-07-15T12:06:58.202Z · change · codex-root

- Scope：curriculum-atlas-final-production-and-preview-release
- Resources：`bdfz-curriculum-atlas`、`bdfz-curriculum-atlas-preview`、`bdfz-curriculum-atlas-sources`、`bdfz-curriculum-atlas-sources-preview`
- Evidence：production-worker-a53c6316-preview-worker-cc6dec86-and-source-manifest-196-entries-republished-with-local-production-preview-sha-parity
- Rollback：production-worker-cefceec5-preview-worker-3abb7b51-and-production-D1-bookmark-00000024-00000138-000050a9-92472a9486e03e820e754bf9815e5747
- Unresolved：OCR-continuous-drain-and-editorial-online-same-edition-review-remain-in-progress

### 2026-07-15T12:06:58.232Z · verify · codex-root

- Scope：curriculum-atlas-final-live-contract
- Resources：`curriculum.bdfz.net`、`bdfz-curriculum-atlas-preview.bdfz.workers.dev`、`Playwright`、`Pulse`、`User-Center`、`Nav`
- Evidence：health-196-of-196-160-subject-16-course-20-scope-zero-unclassified-assets-sha-matched-452-episodes-429-relations-browser-29-facets-zero-errors-zero-overflow-tests-55-of-55-pulse-254-requests-zero-errors
- Rollback：production-worker-cefceec5-preview-worker-3abb7b51-and-code-backup-branch-backup-curriculum-course-taxonomy-visual-20260715-v6
- Unresolved：OCR-8360-pages-remained-at-1203Z-and-machine-output-stays-non-citable-until-editorial-verification

### 2026-07-15T12:09:04.903Z · closeout · codex-root

- Scope：curriculum-atlas-leaf-release-and-ocr-handoff
- Resources：`curriculum-atlas`、`curriculum.bdfz.net`、`bdfz-curriculum-atlas-preview`、`curriculum-ocr-quality-supervisor`、`canonical-report`
- Evidence：git-2cd7d606-pushed-production-a53c6316-preview-cc6dec86-tests-55-browser-live-assets-and-API-pass-OCR-346-of-8690-zero-failures-at-120558Z
- Rollback：backup-branch-backup-curriculum-course-taxonomy-visual-20260715-v6-production-cefceec5-preview-3abb7b51-D1-bookmark-00000024-00000138-000050a9-92472a9486e03e820e754bf9815e5747
- Unresolved：8344-raw-pages-remain-under-singleton-continuous-drain-ETA-36-to-45-hours-plus-editorial-same-edition-online-verification-before-citation

### 2026-07-15T12:10:29.308Z · verify · codex-root

- Scope：curriculum-atlas-post-closeout-drain-continuity
- Resources：`curriculum-atlas-local-ocr`
- Evidence：third-consecutive-64-page-batch-finished-zero-failures-361-of-8690-complete-and-next-biology-64-page-batch-started-within-two-seconds-weighted-throughput-38-point-14-pages-per-10-minutes
- Rollback：persistent-monitor-and-recorded-drain-owner-only-no-action-required
- Unresolved：8329-raw-pages-remain-estimated-center-36-point-40-hours-and-all-output-non-citable-until-editorial-review

</details>

<details><summary><code>curriculum-course-taxonomy-model</code> · 4 events · 2026-07-15T10:17:24.161Z → 2026-07-15T10:24:00.475Z</summary>

Agents：`codex-subagent-course-taxonomy`
Resources：`data/concept-model-v2.json`、`scripts/document-classification.mjs`、`scripts/build-concept-evolution.mjs`、`scripts/validate-concept-evolution.mjs`、`tests`、`docs`、`tests/document-classification.test.mjs`、`tests/concept-evolution-academic-schema.test.mjs`、`tests/subject-facets.test.mjs`、`docs/concept-evolution-academic-model.md`、`docs/data-methodology.md`、`docs/data-model.md`、`public/data/concept-evolution.json`、`public/data/concept-evolution-academic.json`、`data/concept-evolution-quality.json`、`concepts-build`、`concepts-validate`、`npm-test`、`curriculum-atlas-taxonomy-builder-validator-tests-docs-generated-concept-artifacts`

### 2026-07-15T10:17:24.161Z · start · codex-subagent-course-taxonomy

- Scope：curriculum-atlas-taxonomy-generator-tests-docs
- Resources：`data/concept-model-v2.json`、`scripts/document-classification.mjs`、`scripts/build-concept-evolution.mjs`、`scripts/validate-concept-evolution.mjs`、`tests`、`docs`
- Evidence：parent-delegated-disjoint-files-current-tree-only-ocr-supervisor-dirty-and-explicitly-excluded
- Rollback：restore-task-files-from-backup-branch-backup/curriculum-course-taxonomy-visual-20260715-v6
- Unresolved：implementation-and-validation-pending

### 2026-07-15T10:23:40.317Z · change · codex-subagent-course-taxonomy

- Scope：curriculum-atlas-local-taxonomy-and-generated-concept-artifacts
- Resources：`data/concept-model-v2.json`、`scripts/document-classification.mjs`、`scripts/build-concept-evolution.mjs`、`scripts/validate-concept-evolution.mjs`、`tests/document-classification.test.mjs`、`tests/concept-evolution-academic-schema.test.mjs`、`tests/subject-facets.test.mjs`、`docs/concept-evolution-academic-model.md`、`docs/data-methodology.md`、`docs/data-model.md`、`public/data/concept-evolution.json`、`public/data/concept-evolution-academic.json`、`data/concept-evolution-quality.json`
- Evidence：curriculum_course-three-layer-semantics-assessment-subject-facet-and-explicit-course-entity-implemented
- Rollback：restore-listed-task-files-from-backup/curriculum-course-taxonomy-visual-20260715-v6-and-regenerate-concept-artifacts
- Unresolved：production-D1-API-and-deploy-owned-by-parent-task

### 2026-07-15T10:23:40.353Z · verify · codex-subagent-course-taxonomy

- Scope：curriculum-atlas-local-taxonomy
- Resources：`concepts-build`、`concepts-validate`、`npm-test`
- Evidence：196-catalog-documents-classify-as-160-subject-16-course-20-scope-0-unclassified-29-facets-452-episodes-45-tests-pass
- Rollback：no-production-state-changed
- Unresolved：production-preview-and-live-verification-owned-by-parent-task

### 2026-07-15T10:24:00.475Z · closeout · codex-subagent-course-taxonomy

- Scope：curriculum-atlas-local-taxonomy-complete
- Resources：`curriculum-atlas-taxonomy-builder-validator-tests-docs-generated-concept-artifacts`
- Evidence：concepts-build-and-validate-pass-45-of-45-tests-pass-29-facets-17-course-taxonomy-21-course-episodes-zero-course-entity-mismatch
- Rollback：restore-task-files-from-backup/curriculum-course-taxonomy-visual-20260715-v6-and-rerun-concepts-build
- Unresolved：parent-task-must-integrate-D1-health-preview-deploy-and-production-verification

</details>

<details><summary><code>curriculum-controlled-subject-panel</code> · 4 events · 2026-07-15T11:35:49.400Z → 2026-07-15T11:37:11.415Z</summary>

Agents：`codex-docs-closeout-draft`
Resources：`curriculum-atlas/public/app.js`、`curriculum-atlas/tests/subject-facets.test.mjs`

### 2026-07-15T11:35:49.400Z · start · codex-docs-closeout-draft

- Scope：curriculum-atlas-frontend-subject-panel-only
- Resources：`curriculum-atlas/public/app.js`、`curriculum-atlas/tests/subject-facets.test.mjs`
- Evidence：parent-delegated-fill-all-29-controlled-graph-subject-facets-including-zero-episode
- Rollback：revert-only-task-scoped-lines-in-public-app-and-subject-facets-test
- Unresolved：implementation-and-tests-pending

### 2026-07-15T11:37:11.220Z · change · codex-docs-closeout-draft

- Scope：curriculum-atlas-frontend-subject-panel-only
- Resources：`curriculum-atlas/public/app.js`、`curriculum-atlas/tests/subject-facets.test.mjs`
- Evidence：panel-now-seeds-controls-from-graph-subject-facets-intersected-with-facet-eligible-subject-taxonomy-and-preserves-zero-episode-counts
- Rollback：revert-controlledSubjectFacetCounts-load-validation-and-direct-regression-test-only
- Unresolved：verification-pending

### 2026-07-15T11:37:11.316Z · verify · codex-docs-closeout-draft

- Scope：curriculum-atlas-frontend-subject-panel-only
- Resources：`curriculum-atlas/public/app.js`、`curriculum-atlas/tests/subject-facets.test.mjs`
- Evidence：node-check-pass-related-tests-11-of-11-full-node-tests-50-of-50-diff-check-pass-29-facets-seven-zero-episode-course-scope-injection-excluded
- Rollback：no-deploy-no-ocr-no-production-state-change
- Unresolved：none

### 2026-07-15T11:37:11.415Z · closeout · codex-docs-closeout-draft

- Scope：curriculum-atlas-frontend-subject-panel-only
- Resources：`curriculum-atlas/public/app.js`、`curriculum-atlas/tests/subject-facets.test.mjs`
- Evidence：parent-handoff-ready-all-29-controlled-subjects-stable-and-toggleable-including-zero-episode
- Rollback：task-scoped-revert-only-no-production-rollback-required
- Unresolved：parent-retains-deploy-and-cache-version-ownership

</details>

<details><summary><code>curriculum-ocr-silent-acceleration</code> · 3 events · 2026-07-15T12:31:27.176Z → 2026-07-17T02:04:06.058Z</summary>

Agents：`codex-root`
Resources：`curriculum-atlas`、`local-launchagent`、`codex-automation`、`com.suen.curriculum-ocr-watchdog`、`curriculum-ocr-quality-supervisor`、`local OCR watchdog and LaunchAgent topology`

### 2026-07-15T12:31:27.176Z · start · codex-root

- Scope：local-silent-ocr-supervision-and-quality-preserving-throughput
- Resources：`curriculum-atlas`、`local-launchagent`、`codex-automation`
- Evidence：current-queue-434-of-8690-zero-failed-active-batch-healthy
- Rollback：pause-local-watchdog-and-reactivate-existing-codex-automation
- Unresolved：concurrency-benchmark-required-before-production-switch

### 2026-07-15T12:35:44.357Z · change · codex-root

- Scope：replace-visible-cron-monitor-with-local-silent-watchdog
- Resources：`curriculum-atlas`、`com.suen.curriculum-ocr-watchdog`、`curriculum-ocr-quality-supervisor`
- Evidence：launchagent-running-pid-83109-observing-live-drain-pid-4812-automation-paused-six-generated-tasks-archived
- Rollback：launchctl-bootout-watchdog-and-reactivate-paused-automation
- Unresolved：throughput-concurrency-still-under-benchmark

### 2026-07-17T02:04:06.058Z · closeout · codex-root

- Scope：Close superseded local silent-watchdog acceleration task after the guarded remote OCR pipeline assumed execution ownership
- Resources：`local OCR watchdog and LaunchAgent topology`
- Evidence：The later guarded remote A B OCR pipeline superseded this topology; no legacy local drain is active
- Rollback：Do not reactivate legacy automation; use the current supervisor recovery contract if remote execution is abandoned
- Unresolved：Ongoing OCR ownership transfers to curriculum-atlas-full-release-20260716

</details>

<details><summary><code>curriculum-atlas-taxonomy-and-filter-fix</code> · 8 events · 2026-07-15T12:55:21.784Z → 2026-07-15T13:51:21.900Z</summary>

Agents：`codex-root`
Resources：`curriculum-atlas`、`frontend-concept-graph`、`document-taxonomy`、`curriculum-atlas/data/concept-model-v2.json`、`curriculum-atlas/scripts/build-concept-evolution.mjs`、`curriculum-atlas/public/app.js`、`curriculum-atlas/public/atlas.js`、`curriculum-atlas/public/index.html`、`worker:bdfz-curriculum-atlas-preview`、`assets:curriculum-atlas-preview`、`bdfz-curriculum-atlas-preview`、`bdfz-curriculum-atlas-preview.bdfz.workers.dev`、`worker:bdfz-curriculum-atlas`、`domain:curriculum.bdfz.net`、`com.suen.curriculum-ocr-watchdog`、`ocr-supervisor`、`curriculum.bdfz.net`、`bdfz-curriculum-atlas`、`GitHub`、`canonical-report`、`agent-action-log`

### 2026-07-15T12:55:21.784Z · start · codex-root

- Scope：normalize-subject-facets-and-fix-star-map-visibility-copy
- Resources：`curriculum-atlas`、`frontend-concept-graph`、`document-taxonomy`
- Evidence：user-reported-invalid-hanyu-science-fragmented-language-civics-technology-facets-and-hidden-residuals
- Rollback：backup-branch-backup-curriculum-ocr-silent-acceleration-20260715-and-worker-version-rollback
- Unresolved：exact-source-label-distribution-to-audit-before-mapping

### 2026-07-15T13:01:40.800Z · change · codex-root

- Scope：add-two-layer-subject-taxonomy-and-atomic-hide-all-rendering
- Resources：`curriculum-atlas/data/concept-model-v2.json`、`curriculum-atlas/scripts/build-concept-evolution.mjs`、`curriculum-atlas/public/app.js`、`curriculum-atlas/public/atlas.js`、`curriculum-atlas/public/index.html`
- Evidence：exact-subject-identities-retained-display-facets-grouped-global-hide-state-removes-all-nodes-and-filtered-edges-ui-count-copy-removed
- Rollback：restore-files-from-backup-branch-or-roll-back-worker-version
- Unresolved：tests-and-live-browser-verification-pending

### 2026-07-15T13:08:08.116Z · change · codex-root

- Scope：deploy-preview-after-complete-local-verification
- Resources：`worker:bdfz-curriculum-atlas-preview`、`assets:curriculum-atlas-preview`
- Evidence：local-56-tests-types-model-validator-dry-run-and-desktop-mobile-browser-qa-pass
- Rollback：wrangler-rollback-preview-to-version-cc6dec86-d6ec-489e-b4c6-7c0b54f31dcd
- Unresolved：production-deploy-pending-preview-live-smoke

### 2026-07-15T13:15:21.017Z · verify · codex-root

- Scope：preview-live-contract-and-browser-verification
- Resources：`bdfz-curriculum-atlas-preview`、`bdfz-curriculum-atlas-preview.bdfz.workers.dev`
- Evidence：health-v7-196-160-16-20-0-five-bindings-true-local-live-sha-match-12-facets-hide-all-zero-mobile-panel-12-overflow-zero-console-zero
- Rollback：preview-version-cc6dec86-d6ec-489e-b4c6-7c0b54f31dcd
- Unresolved：none

### 2026-07-15T13:15:21.118Z · change · codex-root

- Scope：deploy-verified-preview-build-to-production
- Resources：`worker:bdfz-curriculum-atlas`、`domain:curriculum.bdfz.net`
- Evidence：preview-version-fc0f5923-28e8-4be9-8238-13cc9a33da5b-passed-api-assets-and-browser-smoke
- Rollback：wrangler-rollback-production-to-version-a53c6316-dbee-4e50-a5c2-fabac0fc73ee
- Unresolved：production-live-smoke-pending

### 2026-07-15T13:51:21.702Z · change · codex-root

- Scope：activate-continuous-watchdog-polling-at-clean-batch-boundary
- Resources：`curriculum-atlas`、`com.suen.curriculum-ocr-watchdog`、`ocr-supervisor`
- Evidence：exact-pid-command-cwd-parent-lock-revalidated-history-64-of-64-audited-zero-failures-old-pid-signalled-new-watchdog-and-drain-started-within-about-ten-seconds
- Rollback：bootout-launchagent-after-exact-owner-check-and-run-bounded-supervisor-manually
- Unresolved：7929-pages-remain-strictly-incomplete-and-all-ocr-text-remains-non-citable

### 2026-07-15T13:51:21.801Z · verify · codex-root

- Scope：production-taxonomy-frontend-and-ocr-runtime
- Resources：`curriculum.bdfz.net`、`bdfz-curriculum-atlas`、`bdfz-curriculum-atlas-preview`、`com.suen.curriculum-ocr-watchdog`、`GitHub`
- Evidence：health-v7-196-of-196-five-bindings-true-assets-hash-match-12-display-groups-hide-all-zero-58-tests-gitleaks-clean-git-4080dc2-pushed-watchdog-observing-active-owner-policy-parallel-three
- Rollback：production-b91d1d29-to-a53c6316-preview-fc0f5923-to-cc6dec86-code-backup-branch
- Unresolved：7929-strict-pages-plus-editorial-image-and-same-version-online-verification-remain

### 2026-07-15T13:51:21.900Z · closeout · codex-root

- Scope：curriculum-atlas-subject-facets-and-silent-ocr-acceleration
- Resources：`curriculum-atlas`、`curriculum.bdfz.net`、`canonical-report`、`agent-action-log`
- Evidence：git-4080dc234a64620218c5c0a195bb28a421eeff32-pushed-report-and-association-index-updated-strict-checkpoint-761-of-8690-zero-failures-and-next-batch-running
- Rollback：backup-curriculum-ocr-silent-acceleration-20260715-production-a53c6316-preview-cc6dec86-watchdog-bootout-after-owner-validation
- Unresolved：ocr-continues-silently-at-quality-preserving-three-way-profile-no-automatic-citation-promotion

</details>

<details><summary><code>curriculum-deep-concept-ontology</code> · 5 events · 2026-07-15T14:22:40.717Z → 2026-07-17T02:04:06.105Z</summary>

Agents：`codex-root`、`codex-queue-gap-fix`
Resources：`curriculum-atlas`、`public-concept-graph`、`ocr-supervisor`、`curriculum-atlas/data/local-official-scans.json`、`curriculum-atlas/data/catalog.json`、`curriculum-atlas/data/ocr-queue.json`、`curriculum-atlas/scripts/audit-local-moe-scans.mjs`、`curriculum-atlas/scripts/source-manifest.mjs`、`curriculum-atlas/scripts/prepare-ocr-queue.mjs`、`curriculum-atlas/tests/ocr-queue-coverage.test.mjs`、`curriculum-atlas/tests/ocr-supervisor-faults.test.mjs`、`curriculum-atlas/.cache/ocr-supervisor/watchdog-control.json`、`commit ececd77`、`local official scan and OCR queue sources`

### 2026-07-15T14:22:40.717Z · start · codex-root

- Scope：curriculum-atlas subject-filter ontology UI and OCR supervision
- Resources：`curriculum-atlas`、`public-concept-graph`、`ocr-supervisor`
- Evidence：cross-subject leak reproduced from non-facet course episodes while single subject active
- Rollback：backup/curriculum-deep-ontology-20260715-1425 and prior Cloudflare versions
- Unresolved：OCR corpus remains in progress

### 2026-07-15T14:33:41.613Z · change · codex-queue-gap-fix

- Scope：Local-only MOE 2011/2022 OCR queue coverage metadata and scheduler priority fix
- Resources：`curriculum-atlas/data/local-official-scans.json`、`curriculum-atlas/data/catalog.json`、`curriculum-atlas/data/ocr-queue.json`、`curriculum-atlas/scripts/audit-local-moe-scans.mjs`、`curriculum-atlas/scripts/source-manifest.mjs`、`curriculum-atlas/scripts/prepare-ocr-queue.mjs`、`curriculum-atlas/tests/ocr-queue-coverage.test.mjs`
- Evidence：36 official scans and 3157 pages added fail-closed; Chinese 2011 and 2022 standards assigned priority zero; running OCR process and ledgers untouched
- Rollback：restore task files from backup/curriculum-deep-ontology-20260715-1425; no runtime rollback required
- Unresolved：running drain still holds startup-time queue and requires parent-owned batch-boundary reload

### 2026-07-15T14:33:41.631Z · verify · codex-queue-gap-fix

- Scope：MOE scan audit catalog queue and supervisor regression verification
- Resources：`curriculum-atlas/data/local-official-scans.json`、`curriculum-atlas/data/catalog.json`、`curriculum-atlas/data/ocr-queue.json`、`curriculum-atlas/tests/ocr-queue-coverage.test.mjs`、`curriculum-atlas/tests/ocr-supervisor-faults.test.mjs`
- Evidence：PDF signature page count SHA-256 and native-text scan checks passed for 36 of 36; queue 86 documents 11847 pages blocked MOE zero; 18 of 18 targeted tests passed
- Rollback：generated catalog and queue can be rebuilt after restoring source metadata and scripts
- Unresolved：do not signal current Paddle batch; parent must reload only at verified between-batches boundary

### 2026-07-15T14:53:55.500Z · change · codex-root

- Scope：curriculum-atlas local OCR continuity
- Resources：`curriculum-atlas/.cache/ocr-supervisor/watchdog-control.json`、`curriculum-atlas/data/ocr-queue.json`
- Evidence：safe batch-boundary reload requested so active drain can adopt 86-document 11847-page queue
- Rollback：restore watchdog mode run while preserving append-only OCR ledgers
- Unresolved：current 64-page batch must complete before exact drain termination

### 2026-07-17T02:04:06.105Z · closeout · codex-root

- Scope：Administrative closeout of the predecessor deep-concept and queue-coverage task after its exact source was frozen in ececd77 and handed to the later closed ontology task
- Resources：`commit ececd77`、`local official scan and OCR queue sources`
- Evidence：The exact predecessor source is committed and the successor ontology task closed after later verification
- Rollback：Restore commit ececd77 for this historical scope
- Unresolved：Current dirty revisions of overlapping files belong only to curriculum-atlas-full-release-20260716

</details>

<details><summary><code>curriculum-atlas-deep-ontology</code> · 3 events · 2026-07-15T15:06:36.640Z → 2026-07-15T15:27:31.574Z</summary>

Agents：`codex-root`
Resources：`curriculum-atlas/data`、`curriculum-atlas/public`、`curriculum-atlas/scripts`、`curriculum-atlas/tests`、`curriculum-atlas/docs`、`curriculum-atlas`、`cloudflare_business_audit_2026-05-23.md`、`agent_action_log.jsonl`

### 2026-07-15T15:06:36.640Z · change · codex-root

- Scope：local-source-and-generated-assets
- Resources：`curriculum-atlas/data`、`curriculum-atlas/public`、`curriculum-atlas/scripts`、`curriculum-atlas/tests`、`curriculum-atlas/docs`
- Evidence：76-node-edition-scoped-Chinese-ontology
- Rollback：未记录
- Unresolved：无

### 2026-07-15T15:06:42.121Z · change · codex-root

- Scope：local-source-and-generated-assets
- Resources：`curriculum-atlas/data`、`curriculum-atlas/public`、`curriculum-atlas/scripts`、`curriculum-atlas/tests`、`curriculum-atlas/docs`
- Evidence：76-node-edition-scoped-Chinese-ontology_12-subject-isolation_63-tests_TypeScript_concept-validation_Wrangler-dry-run-passed
- Rollback：backup/curriculum-deep-ontology-20260715-1425
- Unresolved：20-academic-quality-table-indicators-remain-fail-closed_and_OCR-queue-continues-in-background

### 2026-07-15T15:27:31.574Z · closeout · codex-root

- Scope：source-production-OCR-continuity-and-documentation
- Resources：`curriculum-atlas`、`cloudflare_business_audit_2026-05-23.md`、`agent_action_log.jsonl`
- Evidence：commit-ececd77-pushed_main_clean_task-browser-closed_local-dev-stopped_cliDaemon-zero_task-profile-zero_OCR-watchdog-active
- Rollback：backup-branch-and-exact-Worker-version-anchors-recorded
- Unresolved：OCR-continues-fail-closed_quality-table-20-indicators-await-visual-reconstruction

</details>

<details><summary><code>curriculum-atlas-deep-ontology-deploy</code> · 3 events · 2026-07-15T15:06:56.927Z → 2026-07-17T02:04:06.145Z</summary>

Agents：`codex-root`
Resources：`bdfz-curriculum-atlas-preview`、`bdfz-curriculum-atlas`、`curriculum.bdfz.net`、`my.bdfz.net`、`nav.bdfz.net`、`apis.bdfz.net`、`pulse.bdfz.net`、`bdfz-companion`、`bdfz-curriculum-atlas Worker`、`bdfz-curriculum-atlas-preview Worker`

### 2026-07-15T15:06:56.927Z · change · codex-root

- Scope：Cloudflare-preview-then-production-leaf-Worker-assets-only
- Resources：`bdfz-curriculum-atlas-preview`、`bdfz-curriculum-atlas`、`curriculum.bdfz.net`
- Evidence：Wrangler-authenticated_dry-run-passed_no-D1-or-R2-mutation_no-hub-contract-change
- Rollback：preview-cc6dec86-d6ec-489e-b4c6-7c0b54f31dcd_production-a53c6316-dbee-4e50-a5c2-fabac0fc73ee
- Unresolved：production-version-IDs-and-live-QA-pending

### 2026-07-15T15:27:24.208Z · verify · codex-root

- Scope：production-preview-and-dependency-regression
- Resources：`curriculum.bdfz.net`、`bdfz-curriculum-atlas`、`bdfz-curriculum-atlas-preview`、`my.bdfz.net`、`nav.bdfz.net`、`apis.bdfz.net`、`pulse.bdfz.net`、`bdfz-companion`
- Evidence：production-7d1766b2_preview-c9d47854_health-196-of-196_63-tests_console-zero_mobile-no-overflow_ontology-76-nodes_OCR-1228-strict-zero-failures
- Rollback：production-b91d1d29_preview-fc0f5923_source-backup-branch
- Unresolved：quality-table-20-indicators-withheld_OCR-incomplete_core-asset-near-4MiB-gate

### 2026-07-17T02:04:06.145Z · closeout · codex-root

- Scope：Close historical deep-ontology leaf deployment after source and dependency handoff
- Resources：`bdfz-curriculum-atlas Worker`、`bdfz-curriculum-atlas-preview Worker`
- Evidence：Historical production and preview deployment versions and rollback anchors were recorded; preview has since advanced
- Rollback：Use the historical production and preview rollback versions recorded in its verify event
- Unresolved：The next release is owned by curriculum-atlas-full-release-20260716

</details>

<details><summary><code>curriculum-cosmos-focus-and-ocr-recovery-20260715</code> · 15 events · 2026-07-16T00:51:33.785Z → 2026-07-16T02:41:02.174Z</summary>

Agents：`codex-root`、`codex-ui-layout-tests`
Resources：`curriculum-atlas/public`、`curriculum-atlas/data`、`curriculum-atlas/scripts`、`curriculum-atlas/tests`、`curriculum-atlas/docs`、`bdfz-curriculum-atlas`、`bdfz-curriculum-atlas-preview`、`curriculum local OCR cache`、`canonical report`、`agent action log`、`curriculum-atlas/tests/frontend-information-architecture.test.mjs`、`curriculum-atlas/tests/subject-facets.test.mjs`、`curriculum-atlas/docs/frontend-reproduction-verification.md`、`worker:bdfz-curriculum-atlas-preview`、`curriculum-atlas/scripts/ocr-supervisor.mjs`、`curriculum-atlas/scripts/ocr-watchdog.mjs`、`curriculum-atlas/.cache/ocr-supervisor/page-retries.json`、`launchagent:com.suen.curriculum-ocr-watchdog`、`curriculum-atlas/.cache/ocr-supervisor/watchdog-control.json`、`reports/cloudflare_business_audit_2026-05-23.md`、`local-macos:syspolicyd-pid-6492`、`curriculum-atlas`、`worker:bdfz-curriculum-atlas`、`canonical-report`、`github:ieduer/curriculum-atlas`

### 2026-07-16T00:51:33.785Z · start · codex-root

- Scope：Curriculum Atlas full-canvas subject focus, evidence-scoped deepest ontology, and halted OCR recovery
- Resources：`curriculum-atlas/public`、`curriculum-atlas/data`、`curriculum-atlas/scripts`、`curriculum-atlas/tests`、`curriculum-atlas/docs`、`bdfz-curriculum-atlas`、`bdfz-curriculum-atlas-preview`、`curriculum local OCR cache`、`canonical report`、`agent action log`
- Evidence：Repository clean at ececd77; prior curriculum task closed; OCR has no live owner and is fail-closed at chemistry page 84 after peg-native format failure
- Rollback：Create source backup branch and task-scoped OCR state backup before edits; preserve exact Worker preview and production rollback anchors
- Unresolved：Shared hubs, D1, R2, User Center, APIS, nav, Pulse, Companion, raw PDFs, and citation eligibility are excluded from mutation; quality gate remains fail-closed

### 2026-07-16T01:17:33.966Z · start · codex-ui-layout-tests

- Scope：curriculum-atlas-layout-tests-and-frontend-verification-doc-only
- Resources：`curriculum-atlas/tests/frontend-information-architecture.test.mjs`、`curriculum-atlas/tests/subject-facets.test.mjs`、`curriculum-atlas/docs/frontend-reproduction-verification.md`
- Evidence：parent-assigned-disjoint-test-and-doc-ownership-after-frontend-implementation
- Rollback：restore-only-these-three-files-to-ececd77-or-parent-backup-branch-no-production-rollback
- Unresolved：focused-tests-and-doc-contract-update-pending

### 2026-07-16T01:19:54.499Z · verify · codex-ui-layout-tests

- Scope：focused-layout-tests-and-task-diff
- Resources：`curriculum-atlas/tests/frontend-information-architecture.test.mjs`、`curriculum-atlas/tests/subject-facets.test.mjs`、`curriculum-atlas/docs/frontend-reproduction-verification.md`
- Evidence：node-test-two-files-20-of-20-pass-and-task-scoped-git-diff-check-pass
- Rollback：no-production-rollback-required-test-and-doc-only
- Unresolved：browser-and-full-verify-remain-with-parent-owner

### 2026-07-16T01:19:54.514Z · change · codex-ui-layout-tests

- Scope：curriculum-atlas-layout-contract-tests-and-verification-standard
- Resources：`curriculum-atlas/tests/frontend-information-architecture.test.mjs`、`curriculum-atlas/tests/subject-facets.test.mjs`、`curriculum-atlas/docs/frontend-reproduction-verification.md`
- Evidence：added-left-right-rail-order-no-full-width-dock-visible-node-fit-1-point-32-shift-route-and-deep-ontology-search-contracts
- Rollback：restore-only-the-three-task-owned-files-from-ececd77-or-parent-backup-branch
- Unresolved：parent-retains-frontend-data-build-browser-deploy-and-git-ownership

### 2026-07-16T01:20:13.105Z · verify · codex-ui-layout-tests

- Scope：final-focused-layout-test-readback-after-change-row
- Resources：`curriculum-atlas/tests/frontend-information-architecture.test.mjs`、`curriculum-atlas/tests/subject-facets.test.mjs`、`curriculum-atlas/docs/frontend-reproduction-verification.md`
- Evidence：second-sequential-readback-node-test-two-files-20-of-20-pass-and-task-diff-check-pass
- Rollback：no-production-rollback-required-test-and-doc-only
- Unresolved：full-build-browser-and-production-verification-remain-parent-owned

### 2026-07-16T01:20:24.167Z · closeout · codex-ui-layout-tests

- Scope：handoff-layout-tests-and-frontend-verification-doc-to-parent
- Resources：`curriculum-atlas/tests/frontend-information-architecture.test.mjs`、`curriculum-atlas/tests/subject-facets.test.mjs`、`curriculum-atlas/docs/frontend-reproduction-verification.md`
- Evidence：three-files-modified-20-focused-tests-pass-diff-check-pass-no-other-task-file-touched
- Rollback：restore-only-these-three-files-to-ececd77-or-parent-backup-branch
- Unresolved：parent-must-run-full-verify-browser-QA-build-deploy-report-and-git-closeout

### 2026-07-16T01:34:01.698Z · change · codex-root

- Scope：curriculum-full-canvas-ontology-and-ocr-supervisor-hardening
- Resources：`curriculum-atlas/public`、`curriculum-atlas/data`、`curriculum-atlas/scripts`、`curriculum-atlas/tests`、`curriculum-atlas/docs`
- Evidence：single-subject visible-node camera fit; left search and lineage tools; right vertical era and workbench rail; 169 ontology nodes with source-term gates; MuPDF hash pin and bounded Paddle startup idle wall timeouts; focused tests pass
- Rollback：restore source from backup/curriculum-cosmos-focus-20260715-1651 at ececd77 and OCR state from output/backups/curriculum-cosmos-focus-20260715-1651
- Unresolved：production and preview deploy pending; local browser and pdfinfo launches blocked by syspolicyd descriptor leak; OCR remains fail-closed

### 2026-07-16T01:42:48.126Z · change · codex-root

- Scope：deploy-preview-full-canvas-curriculum-cosmos
- Resources：`worker:bdfz-curriculum-atlas-preview`
- Evidence：70 tests pass; TypeScript check pass; concept validation pass; online evidence validation pass; Wrangler dry-run pass; preview rollback c9d47854-1815-4218-a014-66429fbd3b2a
- Rollback：wrangler rollback c9d47854-1815-4218-a014-66429fbd3b2a --env preview
- Unresolved：real browser launch remains subject to macOS syspolicy descriptor leak; preview live smoke pending

### 2026-07-16T01:48:12.776Z · change · codex-root

- Scope：ocr-runtime-failure-reclassification-and-retry-ledger-repair
- Resources：`curriculum-atlas/scripts/ocr-supervisor.mjs`、`curriculum-atlas/scripts/ocr-watchdog.mjs`、`curriculum-atlas/.cache/ocr-supervisor/page-retries.json`
- Evidence：runtime native-load failures now use five-minute PADDLE_RUNTIME_UNAVAILABLE backoff without page retry; dry-run found and apply removed exactly 64 Chinese generic retries; chemistry 84 content quarantine preserved; exact pre-reconcile ledger backed up
- Rollback：restore .cache/ocr-supervisor/page-retries.json.pre-runtime-reconcile-2026-07-16T01-47-48-037Z and source branch backup/curriculum-cosmos-focus-20260715-1651
- Unresolved：local Paddle native dependencies remain blocked by macOS syspolicy descriptor leak; watchdog resumed and will retry without burning page quota

### 2026-07-16T02:12:43.302Z · change · codex-root

- Scope：redeploy-preview-v8-after-final-frontend-and-ocr-fixes
- Resources：`worker:bdfz-curriculum-atlas-preview`
- Evidence：73 tests pass; TypeScript build concept validation and diff check pass; previous preview rollback 55cf188f-b794-4ec5-ab8d-b25ab39f8351
- Rollback：wrangler rollback 55cf188f-b794-4ec5-ab8d-b25ab39f8351 --env preview
- Unresolved：production remains unchanged until real desktop and mobile browser visual QA can run

### 2026-07-16T02:28:04.887Z · change · codex-root

- Scope：reload-local-ocr-watchdog-with-final-fault-containment
- Resources：`launchagent:com.suen.curriculum-ocr-watchdog`、`curriculum-atlas/.cache/ocr-supervisor/watchdog-control.json`
- Evidence：74 tests pass; independent review found zero remaining P0/P1; current watchdog held with no child and exact PID 95779
- Rollback：set watchdog control to hold and kickstart exact LaunchAgent label; source rollback backup/curriculum-cosmos-focus-20260715-1651
- Unresolved：Paddle executable launch may remain blocked by macOS syspolicyd descriptor exhaustion; retry must not consume page quota

### 2026-07-16T02:32:36.616Z · change · codex-root

- Scope：update-canonical-curriculum-resource-and-verification-record
- Resources：`reports/cloudflare_business_audit_2026-05-23.md`
- Evidence：Git main b8344a9 pushed; preview 2459045b live v8; production remains 7d1766b2 v7; 74 tests and preview API/static smoke pass
- Rollback：restore this dated report section and curriculum association row from prior Git/workspace copy; no Cloudflare state changes in report update
- Unresolved：real browser visual gate blocks production promotion; OCR runtime canary still in progress

### 2026-07-16T02:35:05.448Z · change · codex-root

- Scope：exact-syspolicyd-runtime-recovery-for-ocr
- Resources：`local-macos:syspolicyd-pid-6492`
- Evidence：Paddle canary reached import warning but idled 300 seconds; no page retry consumed; syspolicyd PID 6492 at 28 percent CPU with current SecStaticCode failures
- Rollback：launchd automatically restarts the exact Apple service after TERM; verify new PID and leave OCR fail-closed if errors recur
- Unresolved：ChatGPT process may cause descriptor leak to recur; no broad process cleanup or app restart authorized

### 2026-07-16T02:40:53.992Z · verify · codex-root

- Scope：final-preview-source-ocr-and-closeout-verification
- Resources：`curriculum-atlas`、`worker:bdfz-curriculum-atlas-preview`、`worker:bdfz-curriculum-atlas`、`launchagent:com.suen.curriculum-ocr-watchdog`、`reports/cloudflare_business_audit_2026-05-23.md`
- Evidence：Git main and origin at b8344a9; 74 of 74 tests pass; TypeScript build concept validation Wrangler dry-run staged Gitleaks and diff check pass; preview v8 2459045b health schema3 196 of 196 and graph 560 475 169 175 21; production remains v7 7d1766b2; OCR 1464 audited 1529 witness zero missing stale or witness errors and exactly chemistry84 quarantined; Playwright dry-run acted zero
- Rollback：source backup branch backup/curriculum-cosmos-focus-20260715-1651; preview rollback 55cf188f-b794-4ec5-ab8d-b25ab39f8351; production rollback b91d1d29-6f10-49a3-ab40-e4f84af76256; OCR retry ledger backup pre-runtime-reconcile timestamped 2026-07-16T01-47-48-037Z
- Unresolved：v8 browser visual gate not run; macOS syspolicyd still denies Paddle native module after exact restart; 10383 OCR pages and non-Chinese deep ontologies remain fail-closed; DMITPro2 key installation needs user interaction

### 2026-07-16T02:41:02.174Z · closeout · codex-root

- Scope：handoff-preview-v8-full-canvas-and-fail-closed-ocr-monitor
- Resources：`curriculum-atlas`、`worker:bdfz-curriculum-atlas-preview`、`launchagent:com.suen.curriculum-ocr-watchdog`、`canonical-report`、`github:ieduer/curriculum-atlas`
- Evidence：preview v8 and Git b8344a9 delivered; production intentionally unchanged; canonical report and association row current; local preview server closed; no task-owned Playwright process remains; watchdog PID 1671 intentionally persists in run mode with bounded runtime backoff
- Rollback：Git revert b8344a9 or restore backup branch; preview rollback 55cf188f-b794-4ec5-ab8d-b25ab39f8351; set watchdog control hold and kickstart exact label; restore timestamped OCR backups only if ledger rollback is required
- Unresolved：production promotion waits for real browser QA; OCR throughput is blocked by current desktop-session syspolicyd descriptor leak and remote offload waits for interactive BatchMode key installation; no OCR content is citation eligible

</details>

<details><summary><code>curriculum-ocr-max-throughput-20260715</code> · 14 events · 2026-07-16T02:46:39.511Z → 2026-07-16T07:07:09.397Z</summary>

Agents：`codex-root`、`codex-remote-microbatch`、`codex-remote-offload-manifest`
Resources：`curriculum-atlas-local-OCR`、`com.suen.curriculum-ocr-watchdog`、`DMITPro2-inner-bdfz-isolated-OCR-staging`、`canonical-report`、`agent-action-log`、`DMITPro2-inner-bdfz-authorized-keys`、`curriculum-atlas-watchdog-control`、`launchagent-com.suen.curriculum-ocr-watchdog`、`curriculum-atlas/scripts/ocr-pdf-paddle.py`、`curriculum-atlas/tests/ocr-pdf-paddle.test.py`、`curriculum-atlas/scripts/plan-remote-ocr-offload.mjs`、`curriculum-atlas/tests/remote-ocr-offload-planner.test.mjs`、`/private/tmp/curriculum-remote-ocr-offload-manifest.json`、`curriculum-atlas/tests/ocr-pdf-paddle-microbatch.test.mjs`、`curriculum-atlas/tests/test_ocr_pdf_paddle.py`、`curriculum-atlas/tests`、`/Users/ylsuen/CF/curriculum-atlas@f464de0`、`DMITPro2-inner-bdfz-r5`、`reports/cloudflare_business_audit_2026-05-23.md`、`reports/vps_fleet_status_2026-05-23.md`、`production-p4-mb16-shard-a-r5`、`production-p4-mb16-shard-b-r5`、`curriculum-ocr-llama`、`curriculum-ocr-gpu-monitor`、`VPS-report`

### 2026-07-16T02:46:39.511Z · start · codex-root

- Scope：quality-preserving-local-witness-plus-remote-GPU-primary-OCR-acceleration
- Resources：`curriculum-atlas-local-OCR`、`com.suen.curriculum-ocr-watchdog`、`DMITPro2-inner-bdfz-isolated-OCR-staging`、`canonical-report`、`agent-action-log`
- Evidence：prior-owner-closed-at-2026-07-16T02-41-02Z-repo-clean-at-b8344a9-current-strict-baseline-1464-of-11847
- Rollback：set-local-watchdog-control-hold-stop-only-exact-task-owned-remote-process-and-remove-only-new-isolated-staging-after-hash-backed-return
- Unresolved：production-Worker-D1-R2-shared-hubs-citation-eligibility-and-existing-audited-pages-excluded-from-mutation

### 2026-07-16T02:49:18.428Z · change · codex-root

- Scope：install-one-dedicated-operator-public-key-for-batchmode-inner-workstation-access
- Resources：`DMITPro2-inner-bdfz-authorized-keys`
- Evidence：batchmode-proxycommand-returned-hostname-bdfz-and-user-suen-with-selected-ed25519-key
- Rollback：remove-only-the-matching-public-key-line-from-inner-authorized-keys-after-live-key-fingerprint-recheck
- Unresolved：password-not-stored-or-reused-remote-OCR-environment-not-yet-created

### 2026-07-16T02:52:03.174Z · change · codex-root

- Scope：stop-deterministic-zero-throughput-local-recovery-loop-without-touching-ledgers
- Resources：`curriculum-atlas-watchdog-control`、`launchagent-com.suen.curriculum-ocr-watchdog`
- Evidence：last-recovery-ended-PADDLE_RUNTIME_UNAVAILABLE-after-300-second-idle-timeout-with-zero-page-progress-and-zero-page-retry-consumption
- Rollback：restore-control-mode-run-only-after-one-page-native-runtime-canary-passes
- Unresolved：local-1464-completed-and-1529-witness-pages-preserved-remote-GPU-canary-in-progress

### 2026-07-16T02:57:38.910Z · start · codex-remote-microbatch

- Scope：quality-preserving-explicit-PaddleOCRVL-microbatch-support
- Resources：`curriculum-atlas/scripts/ocr-pdf-paddle.py`、`curriculum-atlas/tests/ocr-pdf-paddle.test.py`
- Evidence：parent-assigned-disjoint-file-ownership-repository-clean-at-b8344a9
- Rollback：restore-only-task-owned-script-and-test-file-from-b8344a9
- Unresolved：no-OCR-execution-no-supervisor-watchdog-cache-docs-remote-or-production-mutation

### 2026-07-16T02:58:13.173Z · start · codex-remote-offload-manifest

- Scope：remote-whole-document-offload-planner-only
- Resources：`curriculum-atlas/scripts/plan-remote-ocr-offload.mjs`、`curriculum-atlas/tests/remote-ocr-offload-planner.test.mjs`
- Evidence：prior-owner-closed-new-parent-owner-active-no-overlap-script-and-tests-are-new
- Rollback：remove-only-the-two-new-task-owned-files
- Unresolved：no-ledger-import-or-OCR-execution-authorized

### 2026-07-16T03:02:45.858Z · change · codex-remote-offload-manifest

- Scope：added-fail-closed-whole-document-offload-planner-and-tests
- Resources：`curriculum-atlas/scripts/plan-remote-ocr-offload.mjs`、`curriculum-atlas/tests/remote-ocr-offload-planner.test.mjs`、`/private/tmp/curriculum-remote-ocr-offload-manifest.json`
- Evidence：real-plan-72-documents-5483-pages-2017324713-bytes-source-sha-verified-manifest-sha-3050f22e
- Rollback：remove-only-two-new-source-files-and-private-tmp-manifest
- Unresolved：remote-transfer-runtime-and-import-remain-parent-owned

### 2026-07-16T03:03:48.350Z · verify · codex-remote-offload-manifest

- Scope：focused-offload-planner-contract-and-real-corpus-verification
- Resources：`curriculum-atlas/scripts/plan-remote-ocr-offload.mjs`、`curriculum-atlas/tests/remote-ocr-offload-planner.test.mjs`、`/private/tmp/curriculum-remote-ocr-offload-manifest.json`
- Evidence：node-syntax-pass-four-of-four-tests-pass-real-manifest-72-documents-5483-pages-2017324713-bytes-limit2-cli-pass-diff-and-whitespace-check-pass
- Rollback：no-runtime-or-ledger-state-changed-remove-only-new-files
- Unresolved：full-suite-deferred-because-other-agent-currently-owns-ocr-paddle-files

### 2026-07-16T03:03:57.961Z · closeout · codex-remote-offload-manifest

- Scope：handoff-read-only-remote-offload-planner-and-verified-manifest-to-parent
- Resources：`curriculum-atlas/scripts/plan-remote-ocr-offload.mjs`、`curriculum-atlas/tests/remote-ocr-offload-planner.test.mjs`、`/private/tmp/curriculum-remote-ocr-offload-manifest.json`
- Evidence：only-two-new-task-owned-repo-files-no-OCR-ledger-import-runtime-or-production-mutation-manifest-sha-3050f22e
- Rollback：delete-only-two-new-files-and-two-private-tmp-manifests-if-rejected
- Unresolved：parent-owns-remote-transfer-GPU-runtime-result-validation-local-witness-exact-audit-and-eventual-import

### 2026-07-16T03:04:08.879Z · change · codex-remote-microbatch

- Scope：add-explicit-quality-preserving-PaddleOCRVL-queued-microbatch-mode
- Resources：`curriculum-atlas/scripts/ocr-pdf-paddle.py`、`curriculum-atlas/tests/ocr-pdf-paddle-microbatch.test.mjs`、`curriculum-atlas/tests/test_ocr_pdf_paddle.py`
- Evidence：default-one-page-predict-path-preserved-explicit-queue-mode-adds-sorted-list-temperature-zero-input-path-mapping-streaming-per-page-atomic-commit-and-missing-result-failure
- Rollback：restore-only-three-task-owned-files-from-b8344a9
- Unresolved：Python-runtime-validation-pending-on-Kali-because-local-fixed-venv-startup-hangs-under-known-syspolicyd-failure

### 2026-07-16T03:04:08.900Z · verify · codex-remote-microbatch

- Scope：focused-and-full-static-regression-for-OCR-microbatch-support
- Resources：`curriculum-atlas/tests`、`curriculum-atlas/scripts/ocr-pdf-paddle.py`
- Evidence：npm-test-80-of-80-pass-focused-node-tests-2-of-2-pass-git-diff-check-pass-no-OCR-run
- Rollback：no-production-or-runtime-rollback-required-source-only-uncommitted
- Unresolved：py-compile-and-Python-unittest-must-run-on-Kali-before-first-canary

### 2026-07-16T03:04:15.810Z · closeout · codex-remote-microbatch

- Scope：handoff-quality-preserving-remote-microbatch-source-to-parent
- Resources：`curriculum-atlas/scripts/ocr-pdf-paddle.py`、`curriculum-atlas/tests/ocr-pdf-paddle-microbatch.test.mjs`、`curriculum-atlas/tests/test_ocr_pdf_paddle.py`
- Evidence：three-task-files-ready-npm-80-of-80-and-diff-check-pass-no-runtime-state-or-remote-touch
- Rollback：parent-can-restore-three-files-from-b8344a9
- Unresolved：parent-must-run-Kali-py-compile-Python-unittest-and-real-five-page-canary-before-throughput-scaling

### 2026-07-16T07:07:09.290Z · change · codex-root

- Scope：Commit the fail-closed remote OCR offload implementation and refresh canonical Cloudflare and VPS records
- Resources：`/Users/ylsuen/CF/curriculum-atlas@f464de0`、`DMITPro2-inner-bdfz-r5`、`reports/cloudflare_business_audit_2026-05-23.md`、`reports/vps_fleet_status_2026-05-23.md`
- Evidence：Local unpushed ten-file commit f464de0; r5 owner-lock provenance and known-failure retry implementation; canonical records updated from r4 to r5 with correct RTX 3060 hardware identity
- Rollback：Revert f464de0 if source is rejected; stop and disable exact shard units then restore pre-r5-provenance-lock backup and daemon-reload; report backup retained under backups/reports/2026-07-16/curriculum-ocr-r5-precloseout-20260716T0625Z
- Unresolved：Persistent r5 user units intentionally continue; no push deploy website import Mac ledger mutation D1 or R2 mutation

### 2026-07-16T07:07:09.348Z · verify · codex-root

- Scope：Verify committed source reports and sustained r5 OCR continuation
- Resources：`/Users/ylsuen/CF/curriculum-atlas@f464de0`、`production-p4-mb16-shard-a-r5`、`production-p4-mb16-shard-b-r5`、`curriculum-ocr-llama`、`curriculum-ocr-gpu-monitor`
- Evidence：At 2026-07-16T07:04:01Z A656 plus B527 equals1183 of5483 complete with only pages40 and72 failed; both sidecars exact; four user units active NRestarts0; local Node112 of112 and static checks pass; same final Python SHA previously passed local12 of12 and remote12 of12; remote Node38 of38 and systemd verify pass; Playwright dry-run matched zero cliDaemon
- Rollback：No runtime rollback needed for verification; exact r5 stop and pre-r5 restore path remains documented
- Unresolved：Fixed Homebrew venv closeout rerun hit the known macOS dyld fcntl launcher fault and its exact task child was terminated; 4300 pages and Mac Vision exact audit same-version online checks remain

### 2026-07-16T07:07:09.397Z · closeout · codex-root

- Scope：Release repository and shared-report ownership while the verified persistent OCR services continue unattended
- Resources：`/Users/ylsuen/CF/curriculum-atlas@f464de0`、`canonical-report`、`VPS-report`、`DMITPro2-inner-bdfz-r5`
- Evidence：Repository clean and one local commit ahead of origin; reports and verification standard current; r5 continues at sustained progress with zero unit restart and no task-owned browser daemon
- Rollback：Git revert the local commit for source rollback; restore dated report backup; use exact systemd stop disable and pre-r5 restore only if runtime rollback is required
- Unresolved：Commit is intentionally unpushed; remote output remains non-citable and excluded from website data until whole-document Mac and online verification gates pass

</details>

<details><summary><code>curriculum-atlas-kali-ocr-offload</code> · 12 events · 2026-07-16T04:27:22.837Z → 2026-07-16T07:07:09.452Z</summary>

Agents：`codex-root`
Resources：`curriculum-atlas OCR scripts`、`DMITPro2 inner bdfz workstation`、`curriculum-ocr-llama.service`、`curriculum-ocr-offload.service`、`curriculum-ocr-gpu-monitor.service`、`production-p4-mb16-r2`、`run-identity.json`、`run-status.json`、`remote OCR page artifacts`、`curriculum-ocr-offload@a.service`、`curriculum-ocr-offload@b.service`、`offload-shard-a.json`、`offload-shard-b.json`、`production-p4-mb16-shard-a-r1`、`production-p4-mb16-shard-b-r1`、`production-gpu.csv`、`production-p4-mb16-shard-a-r2`、`production-p4-mb16-shard-b-r2`、`run-remote-ocr-offload.mjs`、`ocr-pdf-paddle.py`、`curriculum-ocr-offload@.service`、`run-status.json.sha256`、`production-p4-mb16-shard-a-r3`、`production-p4-mb16-shard-b-r3`、`curriculum-ocr-peg-isolation.service`、`production-p4-mb16-shard-a-r4`、`production-p4-mb16-shard-b-r4`、`plan-remote-ocr-offload.mjs`、`production-p4-mb16-shard-a-r5`、`production-p4-mb16-shard-b-r5`、`curriculum-ocr-offload@a`、`curriculum-ocr-offload@b`、`curriculum-ocr-llama`、`curriculum-ocr-gpu-monitor`

### 2026-07-16T04:27:22.837Z · change · codex-root

- Scope：Installed isolated DMITPro2 inner Kali CUDA OCR runtime and user-systemd services; held local watchdog to prevent dual ownership.
- Resources：`curriculum-atlas OCR scripts`、`DMITPro2 inner bdfz workstation`、`curriculum-ocr-llama.service`、`curriculum-ocr-offload.service`、`curriculum-ocr-gpu-monitor.service`
- Evidence：Pinned model and mmproj hashes, llama commit, 72-document source validation, P4 and micro-batch canaries; r1 venv path incident retained with zero OCR artifacts; r2 uses lexical venv path.
- Rollback：Stop and disable exact curriculum-ocr-offload service, then exact GPU monitor and llama services; preserve r1/r2 evidence and local accepted OCR state.
- Unresolved：Remote results remain non-citable staging until Mac Vision, exact audit, version-aware online verification, and whole-document import gates pass.

### 2026-07-16T04:27:22.955Z · verify · codex-root

- Scope：Verified corrected r2 OCR execution, first whole document completion, GPU saturation, and fail-closed provenance.
- Resources：`production-p4-mb16-r2`、`run-identity.json`、`run-status.json`、`remote OCR page artifacts`
- Evidence：First document completed 39 of 39 pages in 231.720 seconds with zero failed pages; second document started; GPU reached 100 percent with 2684 MiB, 72 C, approximately 80 W; runner tests 10 of 10 and full suite 91 of 91.
- Rollback：Use exact user-systemd service stop; do not delete completed staging pages or alter the local OCR ledger.
- Unresolved：Corpus run is active; no remote document is approved for local import or publication yet.

### 2026-07-16T04:49:41.281Z · change · codex-root

- Scope：Replaced the intentionally stopped singleton OCR topology with two exact non-overlapping persistent user-systemd shards sharing one pinned P4 CUDA inference service.
- Resources：`DMITPro2 inner bdfz workstation`、`curriculum-ocr-offload@a.service`、`curriculum-ocr-offload@b.service`、`curriculum-ocr-llama.service`、`offload-shard-a.json`、`offload-shard-b.json`
- Evidence：Shard union is exactly 72 documents and 5483 pages; both units enabled and active with zero restarts; completed and partial page artifacts were hash-revalidated before reuse.
- Rollback：Stop and disable exact shard units a and b, then stop the GPU monitor and llama unit; retain all staging artifacts and manifests.
- Unresolved：Remote output remains non-citable staging until local Apple Vision, exact page audit, and online same-version verification pass.

### 2026-07-16T04:49:41.374Z · verify · codex-root

- Scope：Verified sustained dual-shard OCR throughput, process ownership, resource ceiling, and fail-closed state after production continuation.
- Resources：`production-p4-mb16-shard-a-r1`、`production-p4-mb16-shard-b-r1`、`production-gpu.csv`、`run-status.json`
- Evidence：At 230 candidate pages the dual run had added 175 pages in 13.27 minutes, approximately 13.2 pages per minute; 91 of 91 local tests passed; both shard units, llama service, and GPU monitor active; zero failed pages, zero quarantined documents, and zero unit restarts.
- Rollback：Use exact user-systemd unit stop and disable sequence; no local OCR ledger, Cloudflare resource, or live website has been changed.
- Unresolved：The OCR corpus is still running; remote results are not yet imported or publication-approved.

### 2026-07-16T05:05:38.227Z · change · codex-root

- Scope：Paused only the two remote OCR shard units after final fail-closed audit found queue-contract, shared-runtime, child-stall, and runtime-identity gaps; preserved all artifacts and prepared isolated r2 roots.
- Resources：`curriculum-ocr-offload@a.service`、`curriculum-ocr-offload@b.service`、`production-p4-mb16-shard-a-r1`、`production-p4-mb16-shard-b-r1`、`production-p4-mb16-shard-a-r2`、`production-p4-mb16-shard-b-r2`
- Evidence：Intentional stop returned exit 75 with zero remaining OCR children; r1 retained 278 candidate pages, zero failed pages and zero quarantine; r2 copies match old document trees byte-for-byte at SHA 8f578142 and 6bea6bca.
- Rollback：Pre-hardening systemd and script copies retained under the exact run backups directory; r1 roots are immutable evidence and can be inspected without changing r2.
- Unresolved：Do not restart until hardened runner and queue-contract tests pass locally and in the Kali venv.

### 2026-07-16T05:19:21.200Z · change · codex-root

- Scope：Deployed hardened remote OCR scripts and moved the two user-systemd shards to new r2 output roots after exact backup and byte-identical state migration.
- Resources：`run-remote-ocr-offload.mjs`、`ocr-pdf-paddle.py`、`curriculum-ocr-offload@.service`、`production-p4-mb16-shard-a-r2`、`production-p4-mb16-shard-b-r2`
- Evidence：Remote script SHA values 08616cee and 04fce558 match local; pre-hardening scripts and unit retained; r1 document trees copied to r2 with exact SHA 8f578142 and 6bea6bca; systemd user-unit verification passed.
- Rollback：Stop and disable exact a and b shard units, restore the timestamped pre-r2 unit and script backups, daemon-reload, and retain all r1 and r2 evidence roots.
- Unresolved：Remote results remain non-citable and have not been imported to the Mac ledger or website.

### 2026-07-16T05:19:21.285Z · verify · codex-root

- Scope：Verified hardened r2 runtime identity, fail-closed tests, status integrity, restart count, and live two-shard checkpoint continuation.
- Resources：`curriculum-ocr-offload@a.service`、`curriculum-ocr-offload@b.service`、`run-identity.json`、`run-status.json`、`run-status.json.sha256`、`production-p4-mb16-shard-a-r2`、`production-p4-mb16-shard-b-r2`
- Evidence：Kali runner tests 15 of 15 and Python tests 10 of 10 passed; local suite 96 of 96 passed; both runtime fingerprints equal a45041b1; by 05:16:25 UTC staging reached 346 pages, with A at 64 of 75, B completing 52 of 52 then committing 16 pages of its next document; sidecars OK, zero failed pages, zero quarantines, zero restarts.
- Rollback：Exact pre-r2 backup is retained and old r1 roots are unchanged; no Cloudflare, D1, R2, live site, or Mac OCR ledger mutation occurred.
- Unresolved：Full 5483-page remote shard completion plus Mac render, Apple Vision, exact audit, same-edition online verification, and publication import remain pending.

### 2026-07-16T05:33:07.489Z · change · codex-root

- Scope：Stopped only the two OCR shard units at 480 staged pages to close a fail-closed shared-runtime audit gap and prepared immutable r3 continuation roots.
- Resources：`curriculum-ocr-offload@a.service`、`curriculum-ocr-offload@b.service`、`production-p4-mb16-shard-a-r2`、`production-p4-mb16-shard-b-r2`、`production-p4-mb16-shard-a-r3`、`production-p4-mb16-shard-b-r3`、`run-remote-ocr-offload.mjs`
- Evidence：Both shards returned intentional exit 75 with zero OCR child owners; r2 stopped at A 243 plus B 237 pages, zero failed pages, zero quarantine, zero restarts; r3 document and cache copies match r2 tree hashes exactly.
- Rollback：Pre-r3 unit and script backup plus immutable r1 and r2 output roots are retained; only shard units were stopped, llama and GPU telemetry stayed active.
- Unresolved：Upload the final pinned runner, verify tests and identities, then resume r3; Mac Vision, exact audit, online same-edition verification, import, and publication remain pending.

### 2026-07-16T05:50:13.758Z · change · codex-root

- Scope：Stopped only r3 OCR shards after fail-closed acceptance found one queued PEG-native parser error amplified to 16 page failures; preserved evidence and began page-isolated recovery.
- Resources：`curriculum-ocr-offload@a.service`、`curriculum-ocr-offload@b.service`、`production-p4-mb16-shard-a-r3`、`production-p4-mb16-shard-b-r3`、`curriculum-ocr-peg-isolation.service`
- Evidence：At 05:41:06 UTC A stopped at 259 pages with zero failed pages and B at 237 pages with failed markers 33 through 48; both exit75, NRestarts0, no residual OCR owner. P1 diagnostic recovered 15 of pages33-48 and isolated deterministic PEG-native 500 to physical page40; llama stayed healthy with zero restart.
- Rollback：r1 r2 and r3 roots plus logs and sidecars remain immutable; llama and GPU monitor remain active; diagnostic uses a separate output root.
- Unresolved：Deploy r4 with runner invocation-error revalidation and MB16-to-strict-single-page fallback; page40 remains fail-closed pending alternate OCR or Mac and online verification.

### 2026-07-16T06:04:08.807Z · change · codex-root

- Scope：Deployed the page-isolating r4 OCR continuation with immutable runner identity and resumed both exact-disjoint Kali shards after preserving r3.
- Resources：`run-remote-ocr-offload.mjs`、`ocr-pdf-paddle.py`、`curriculum-ocr-offload@a.service`、`curriculum-ocr-offload@b.service`、`production-p4-mb16-shard-a-r4`、`production-p4-mb16-shard-b-r4`
- Evidence：r4 A and B started 05:53:10 UTC with runner SHA 39924184, OCR SHA abf9f645, runtime fingerprint a45041b1, exact copied trees, remote Node 22 of 22 and Python 11 of 11 tests; both user units active with zero restarts.
- Rollback：Stop and disable exact a and b user units; immutable r1 through r3 roots and pre-r4 scripts, unit, and tree hashes remain available; do not delete staging evidence.
- Unresolved：Physical page 40 of the experimental high-school Russian standard remains a deterministic PEG-native failure and stays non-citable; remaining corpus and all Mac Vision, exact audit, online same-version verification, import, and publication gates are pending.

### 2026-07-16T06:41:15.089Z · change · codex-root

- Scope：Promoted the validated r5 fail-closed runner, planner, and OCR retry identities to the two inner-Kali staging shards after exact r4 stop and byte-identical state migration.
- Resources：`run-remote-ocr-offload.mjs`、`plan-remote-ocr-offload.mjs`、`ocr-pdf-paddle.py`、`curriculum-ocr-offload@a.service`、`curriculum-ocr-offload@b.service`、`production-p4-mb16-shard-a-r5`、`production-p4-mb16-shard-b-r5`
- Evidence：r4 stopped intentionally at A529 plus B426 equals955 completed pages with two failed pages, exit75 and zero restarts; r5 document and cache trees match r4 exactly at SHA 2d4e49f3 and fd037264; runner SHA8d19a7b0, OCR SHAb4ea8730, planner SHA4b248524; remote Node38 of38, Python12 of12 and systemd verify passed; both r5 units active with zero restarts.
- Rollback：Stop and disable exact r5 a and b units, restore the pre-r5 unit and scripts from the timestamped remote backup, daemon-reload, and preserve all r1 through r5 roots; r4 remains immutable at the stop checkpoint.
- Unresolved：Remote corpus is still running and non-citable; pages40 and72 of the Russian standard need alternate recognition and Mac plus same-edition verification; no website or local OCR ledger import has occurred.

### 2026-07-16T07:07:09.452Z · closeout · codex-root

- Scope：Close the r1 through r5 implementation window while leaving the four approved persistent user units running
- Resources：`curriculum-ocr-offload@a`、`curriculum-ocr-offload@b`、`curriculum-ocr-llama`、`curriculum-ocr-gpu-monitor`
- Evidence：r5 active at1183 of5483 complete two fail-closed pages zero restarts with exact identities and sidecars; parent task owns ongoing corpus and quality follow-up
- Rollback：Stop and disable exact shard units before monitor and llama; restore pre-r5-provenance-lock backup only after preserving r1 through r5 evidence
- Unresolved：Pages40 and72 plus remaining corpus Mac witness audit online same-edition verification and import are pending

</details>

<details><summary><code>curriculum-ocr-post-reboot-recovery-20260716</code> · 5 events · 2026-07-16T08:21:34.936Z → 2026-07-16T08:33:32.722Z</summary>

Agents：`codex-root`
Resources：`DMITPro2 pid 333299`、`127.0.0.1:22222`、`DMITPro2 inner bdfz workstation`、`curriculum-ocr-llama.service`、`curriculum-ocr-offload@a.service`、`curriculum-ocr-offload@b.service`、`curriculum-ocr-gpu-monitor.service`、`r5 run sidecars`、`DMITPro2:sshd pid 333299`、`DMITPro2 inner bdfz:curriculum-ocr-gpu-monitor.service`、`default.target.wants`、`production-gpu.csv`、`DMITPro2 127.0.0.1:22222`、`inner bdfz four OCR user units`、`r5 shard A and B run-status/status artifacts`、`curriculum-atlas clean source`、`DMITPro2 restored reverse tunnel`、`inner bdfz OCR units`、`r5 outputs`

### 2026-07-16T08:21:34.936Z · start · codex-root

- Scope：Recover and monitor the existing r5 OCR job after inner Kali reboot; outer stale reverse-tunnel session and exact four inner user units only; no OCR data edits or Cloudflare/site changes
- Resources：`DMITPro2 pid 333299`、`127.0.0.1:22222`、`DMITPro2 inner bdfz workstation`、`curriculum-ocr-llama.service`、`curriculum-ocr-offload@a.service`、`curriculum-ocr-offload@b.service`、`curriculum-ocr-gpu-monitor.service`、`r5 run sidecars`
- Evidence：Outer read-only probe shows old sshd PID 333299 owns stale 22222 listener while three new inner tunnel attempts fail Address already in use; curriculum-atlas source is clean and prior OCR owner is closed
- Rollback：Do not restart sshd or VPS; terminate only revalidated stale PID; inner systemd tunnel retries automatically; if OCR unit recovery is needed stop only the exact units to return to captured sidecar state
- Unresolved：Restore tunnel, inspect boot-time auto-recovery and state integrity, then prove forward progress with two snapshots

### 2026-07-16T08:21:55.328Z · change · codex-root

- Scope：Released only the stale pre-reboot reverse SSH listener on DMITPro2 so the rebooted Kali tunnel can reclaim localhost 22222
- Resources：`DMITPro2:sshd pid 333299`、`127.0.0.1:22222`
- Evidence：Immediately before TERM the exact PID executable was /usr/sbin/sshd and fd5 alone listened on 127.0.0.1:22222; after TERM the PID exited and the listener was clear
- Rollback：No service or config was changed; the enabled Kali reverse-tunnel unit will recreate the listener on its normal retry cycle
- Unresolved：Await new listener, reconnect to inner bdfz, verify four OCR units and r5 state progression

### 2026-07-16T08:26:58.708Z · change · codex-root

- Scope：Restore bounded GPU telemetry now and make the existing monitor unit join the user default target on future boots without changing its unit contents
- Resources：`DMITPro2 inner bdfz:curriculum-ocr-gpu-monitor.service`、`default.target.wants`、`production-gpu.csv`
- Evidence：Unit SHA256 de2e24cddb31df7bb411ac9122d34ded227ab3b2c33af7261c18028a9e2276a6 unchanged; added one exact wants symlink; monitor active running PID 23598 NRestarts 0 and new five-second telemetry rows appended
- Rollback：systemctl --user stop curriculum-ocr-gpu-monitor.service then systemctl --user remove-wants default.target curriculum-ocr-gpu-monitor.service; unit file and historical CSV stay preserved
- Unresolved：Need compact state integrity check and second progress snapshot to prove post-reboot forward motion

### 2026-07-16T08:33:22.178Z · verify · codex-root

- Scope：Verify tunnel recovery, automatic OCR boot continuation, persistent telemetry, state integrity, and real post-reboot production progress
- Resources：`DMITPro2 127.0.0.1:22222`、`inner bdfz four OCR user units`、`r5 shard A and B run-status/status artifacts`、`production-gpu.csv`
- Evidence：At 08:32:02Z new tunnel PID 389632 was stable; r5 reached 2236/5483 pages from 2127 at 08:25:13Z; A 1205 and B 1031; all four OCR units active running NRestarts 0; llama health ok; runtime fingerprint unchanged; 33 complete status hashes and both run-status sidecars verified; zero quarantined and only known Russian pages 40 and 72 failed; GPU 76 percent at 76 C with 2572/6144 MiB and telemetry age 1 second; disk 328 GiB free
- Rollback：Monitor-only persistence rollback is stop the exact monitor and remove-wants default.target; no OCR outputs or identities were modified; stale reverse listener is intentionally not restorable
- Unresolved：3247 pages remain; Russian pages 40 and 72 require alternate recognition and later Mac dual-source and online same-version QA; unrelated openclaw-gateway failed on Node 22.22.2 version floor and was not touched; canonical report append deferred because stublogs-home task currently owns that file

### 2026-07-16T08:33:32.722Z · closeout · codex-root

- Scope：Close the reboot incident while leaving the verified persistent r5 OCR pipeline and telemetry running unattended
- Resources：`curriculum-atlas clean source`、`DMITPro2 restored reverse tunnel`、`inner bdfz OCR units`、`r5 outputs`
- Evidence：No local source or OCR data mutation; repository remains main ahead one and clean; reverse access restored by removing only stale PID 333299; monitor linked to default.target; production advanced to 40.78 percent with both shards writing and no new quarantine
- Rollback：Stop and remove-wants only the GPU monitor to undo the persistent telemetry change; OCR A B and llama remain under their prior enabled topology; do not delete r1-r5 evidence
- Unresolved：OCR continues with 3247 pages and two known fail-closed Russian pages; final corpus import and website update remain gated on full OCR and quality review; canonical report merge remains deferred until overlapping report ownership closes

</details>

<details><summary><code>curriculum-r5-six-page-repair-20260716</code> · 10 events · 2026-07-16T13:14:41.870Z → 2026-07-17T02:04:06.186Z</summary>

Agents：`codex-root`、`root`
Resources：`/Users/ylsuen/CF/curriculum-atlas`、`DMITPro2 inner r5 outputs`、`moe-2011-02:85`、`moe-2022-08:81/94`、`ictr-3db457c6f361:72`、`moe-2011-04:42/62`、`/Users/ylsuen/CF/curriculum-atlas/scripts/vision-ocr-batch.swift`、`DMITPro2 inner bdfz workstation`、`production-p4-mb16-shard-a-r6-repaired`、`production-p4-mb16-shard-b-r6-repaired`、`authorized_keys`、`repair-manifest-shard-a.json`、`repair-manifest-shard-b.json`、`/private/tmp/curriculum-r6-receive-20260716T1435Z.tar.zst`、`/Users/ylsuen/CF/curriculum-atlas/.cache/remote-ocr-offload/20260716-r6`、`/private/tmp/curriculum-r6-receive-dry-run.json`、`/Users/ylsuen/CF/curriculum-atlas/.cache/remote-ocr-repair/20260716-r5-six-pages`、`DMITPro2 inner bdfz:/home/suen/curriculum-ocr-offload/tools/curriculum-r6-tools-copy/receive-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-production`、`/Users/ylsuen/CF/curriculum-atlas/.cache/text`、`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-receipts`、`/private/tmp/curriculum-r6-receiver-locked`、`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-receipts/2026-07-16T14-58-25-768Z-3050f22e7bda-2d3f55d6/receipt.json`、`/private/tmp/curriculum-r6-receive-idempotent.json`、`/private/tmp/curriculum-ocr-status-after-r6.json`、`curriculum-atlas/scripts/vision-ocr-batch.swift`、`six-page repair receipt`

### 2026-07-16T13:14:41.870Z · start · codex-root

- Scope：Resolve the six fail-closed r5 pages with fresh 240-DPI source renders, blind Apple Vision, independent alternate OCR, same-edition official or academic evidence, and strict page/document integrity gates; prepare but do not deploy or import public data until all gates pass
- Resources：`/Users/ylsuen/CF/curriculum-atlas`、`DMITPro2 inner r5 outputs`、`moe-2011-02:85`、`moe-2022-08:81/94`、`ictr-3db457c6f361:72`、`moe-2011-04:42/62`
- Evidence：Repository main is clean and one commit ahead; remote r5 settled at 5477/5483 with four quarantined documents and exactly six PEG-native parser failures; local watchdog held with no active OCR owner; pinned MuPDF 1.28.0 hash verified
- Rollback：Keep original PDFs, remote r5 states, failure logs and hashes immutable; all repair evidence goes to an isolated new directory and can be removed without changing the existing ledger; no D1 R2 Worker or published graph mutation in this phase
- Unresolved：Need exact-page render/Vision/alternate OCR, version-aware online adjudication, repair integration tests, whole-document revalidation and Mac quality gate

### 2026-07-16T13:32:02.090Z · change · codex-root

- Scope：Harden Apple Vision batch OCR language selection and deterministic evidence serialization without changing the default recognition profile
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/vision-ocr-batch.swift`
- Evidence：Added validated optional language list; unsupported or empty lists exit fail-closed; default remains zh-Hans plus en-US; sorted JSON keys make repeated evidence byte-stable; typecheck and default-versus-explicit functional canary pass
- Rollback：Revert only scripts/vision-ocr-batch.swift to the pre-task Git version; existing OCR evidence and remote r5 remain unchanged
- Unresolved：Supervisor still needs document-language routing and provenance integration; no OCR ledger or published data changed

### 2026-07-16T14:06:06.518Z · change · root

- Scope：Created isolated r6 shard copies on DMITPro2 inner bdfz workstation and installed the existing local operator public key for noninteractive bounded transfer; immutable r5 shards remain untouched
- Resources：`DMITPro2 inner bdfz workstation`、`production-p4-mb16-shard-a-r6-repaired`、`production-p4-mb16-shard-b-r6-repaired`、`authorized_keys`
- Evidence：BatchMode SSH verified as suen on host bdfz; inner host ED25519 fingerprint SHA256:xiNrEyyKHiOKqV3xQxFfPrDk4Gk9tW4NfktYVkZkjr8; operator public-key fingerprint SHA256:e73pr21TkFK1jOFIOyb5w6GsJlTEsOZbNzHQdLNI3Hw; r6 A and B are isolated 301M and 297M copies
- Rollback：Remove only the authorized_keys line matching the recorded operator public-key fingerprint; remove only the two r6-repaired directories and repair staging directory after preserving receipts; never alter r5
- Unresolved：Repair evidence transfer and r6 dry-run/apply/full validation still pending

### 2026-07-16T14:30:32.080Z · change · root

- Scope：Prepared to atomically apply six independently adjudicated PEG-native page repairs to isolated r6 shard copies only after both manifests and all evidence passed remote dry-run
- Resources：`production-p4-mb16-shard-a-r6-repaired`、`production-p4-mb16-shard-b-r6-repaired`、`repair-manifest-shard-a.json`、`repair-manifest-shard-b.json`
- Evidence：Remote dry-run returned ready for both shards; manifest SHA sidecars passed; six exact final-text hashes and rendered-image hashes were revalidated; citation remains false; immutable r5 remains untouched
- Rollback：Adapter receipt supports exact-page rollback; if repair is rejected discard only r6-repaired copies and retain r5 plus all source failure evidence
- Unresolved：Apply, idempotent revalidation, 72-document receiver validation, and Mac import remain pending

### 2026-07-16T14:45:39.868Z · verify · root

- Scope：Verified the six-page isolated r6 repair receipts, idempotent re-entry, compressed transport archive, and local readback; formal 72-document receive remains fail-closed pending the discovered native Markdown asset contract fix
- Resources：`production-p4-mb16-shard-a-r6-repaired`、`production-p4-mb16-shard-b-r6-repaired`、`/private/tmp/curriculum-r6-receive-20260716T1435Z.tar.zst`、`/Users/ylsuen/CF/curriculum-atlas/.cache/remote-ocr-offload/20260716-r6`
- Evidence：Shard A receipt SHA256 22eae7d92abdb62ea692425886b95fdd89350d26880f94cfcdd8e41bccce1472; shard B receipt SHA256 190b7bad08f445b7e64ed6530225200dc86295ff90a0017b49dc8b36c834cb06; both dry-runs return verified_idempotent; 18051-file archive SHA256 31a4e514bed69df100fa65c0e8df3206d450dee1e293479901c91b4093d09052 matched inner, outer, and Mac readback; no symlinks
- Rollback：Discard only local extracted staging and task-created archive/export copies; adapter receipts can roll back exact repaired pages or the two r6 copies can be discarded; immutable r5 remains the rollback anchor
- Unresolved：Receiver rejected legitimate Paddle markdown/imgs assets on the first real document; scoped receiver fix and complete 72-document validation are in progress; no formal cache import or deployment has occurred

### 2026-07-16T14:53:29.982Z · verify · root

- Scope：Validated the complete staged r6 receiver dataset locally with the repaired native Paddle asset contract before any cache import
- Resources：`/private/tmp/curriculum-r6-receive-dry-run.json`、`/Users/ylsuen/CF/curriculum-atlas/.cache/remote-ocr-offload/20260716-r6`、`/Users/ylsuen/CF/curriculum-atlas/.cache/remote-ocr-repair/20260716-r5-six-pages`
- Evidence：dry_run_validated; 72 documents; 5483 pages; 6 repaired pages; 68 complete source states; 4 quarantined source states; citation_allowed false; 34 prior text files identified for backup
- Rollback：No mutation occurred; discard only the dry-run receipt file if desired
- Unresolved：Need matching source-side dry-run with the patched receiver before local atomic apply

### 2026-07-16T14:53:30.015Z · change · root

- Scope：Prepare to update only the isolated r6 receiver tool copy on the inner workstation for source-side validation; immutable r5 and r6 data remain unchanged
- Resources：`DMITPro2 inner bdfz:/home/suen/curriculum-ocr-offload/tools/curriculum-r6-tools-copy/receive-remote-ocr-offload.mjs`
- Evidence：Local receiver SHA256 c7141fd1f6237a5abd79330660fc0e72af2716c8be4d7e53be928fc0d539007c; local full staged dry-run passed exact expected counts
- Rollback：Restore the prior isolated tool file or discard the task-created tool directory; OCR shard data and receipts are unaffected
- Unresolved：Source-side dry-run must still pass exact 72 document 5483 page 6 repair assertions

### 2026-07-16T14:58:04.656Z · change · root

- Scope：Atomically import the validated 72-document r6 OCR corpus into the local OCR cache using the locked receiver version only; preserve the held watchdog and keep all pages non-citable
- Resources：`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-production`、`/Users/ylsuen/CF/curriculum-atlas/.cache/text`、`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-receipts`、`/private/tmp/curriculum-r6-receiver-locked`
- Evidence：Locked receiver SHA256 c7141fd1f6237a5abd79330660fc0e72af2716c8be4d7e53be928fc0d539007c passed a fresh full dry-run; local and Kali independently matched 72 documents 5483 pages 6 repair pages 68 complete 4 quarantined and citation false; watchdog status held with no child
- Rollback：Use the generated receiver receipt rollback action to remove installed document trees and restore all 34 prior text files; immutable r5 and staged r6 archives remain retained
- Unresolved：Apply receipt, idempotent replay, supervisor reconciliation, Vision witness and page publication review remain pending

### 2026-07-16T14:59:58.233Z · verify · root

- Scope：Verified the local r6 corpus import receipt idempotence exact installed page count and supervisor reconciliation without opening citation
- Resources：`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-receipts/2026-07-16T14-58-25-768Z-3050f22e7bda-2d3f55d6/receipt.json`、`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-production`、`/private/tmp/curriculum-r6-receive-idempotent.json`、`/private/tmp/curriculum-ocr-status-after-r6.json`
- Evidence：Receipt SHA256 10dec8b2fddf3c92c0d52990c18c75e244f9a7cbb1b7dbb56c5d255d486a39a1; status applied then verified_idempotent; 72 imported documents plus 14 preserved local partial documents; exactly 6947 content.md pages; zero symlinks; supervisor reports 6947 completed and 4900 pending; 5483 new witnesses missing; citation eligible remains zero
- Rollback：Use only receipt-recorded per-document target hashes and text backups in reverse order; immutable r5 staged r6 and archive hashes remain available
- Unresolved：Need Apple Vision witness and audit backfill for 5483 pages plus remote whole-document processing for the remaining 14 partial documents

### 2026-07-17T02:04:06.186Z · closeout · codex-root

- Scope：Close the completed six-page repair and transfer the validated Vision language and serialization source change to the full release
- Resources：`curriculum-atlas/scripts/vision-ocr-batch.swift`、`six-page repair receipt`
- Evidence：The six-page repair receipt is complete and the later Vision evidence drain completed; outputs remain citation false
- Rollback：Preserve the append-only repair receipt and revert only the transferred Swift source if needed
- Unresolved：Repair evidence remains non-citable until shared publication gates pass

</details>

<details><summary><code>curriculum-remote-ocr-receiver-20260716</code> · 4 events · 2026-07-16T13:27:22.521Z → 2026-07-16T14:03:23.998Z</summary>

Agents：`/root/corpus_import_gate`
Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-receiver.test.mjs`

### 2026-07-16T13:27:22.521Z · start · /root/corpus_import_gate

- Scope：Implement default-dry-run whole-document atomic receiver for local OCR shard staging only; exclude Vision Swift, six-page repair generation, D1, R2, Worker, reports and deployment
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-receiver.test.mjs`
- Evidence：Repo main ahead one; only pre-existing dirty file is scripts/vision-ocr-batch.swift owned by six-page repair task; assigned files are absent and unowned
- Rollback：Delete only the two new untracked receiver files if rejected; no cache apply will be run during implementation tests outside temporary fixtures
- Unresolved：Repair manifest schema must align with the concurrently prepared six-page repair evidence

### 2026-07-16T14:02:03.055Z · change · /root/corpus_import_gate

- Scope：Implemented a default-dry-run whole-document-atomic local receiver for independently staged remote OCR shards, including explicit repair manifest and receipt verification, evidence archival, joined text generation, rollback, and idempotent re-entry; no deploy or live cache import
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-receiver.test.mjs`
- Evidence：Receiver reuses the existing remote manifest and document validators plus the repair adapter manifest validator; citation remains false at every checked layer; repairs require exact manifest receipt state artifact and evidence hashes
- Rollback：Both deliverables are new untracked files and can be removed without affecting existing OCR code; no production cache D1 R2 Worker Pages or deployment state changed
- Unresolved：No real shard apply was authorized or run; parent agent must coordinate actual staging paths and repair manifests before any import

### 2026-07-16T14:03:23.969Z · verify · /root/corpus_import_gate

- Scope：Verified the remote OCR receiver and repair-contract integration entirely in temporary fixtures; no real cache import or deployment was performed
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-receiver.test.mjs`
- Evidence：Focused receiver and repair tests pass 37 of 37; related receiver runner repair and corpus tests pass 64 of 64; TypeScript check passes; final full npm test passes 154 of 154; dry-run apply rollback evidence drift receipt drift Markdown drift citation fail-closed and idempotence paths are covered
- Rollback：No production rollback is required; implementation remains two new untracked files and all apply tests used temporary directories cleaned by the test harness
- Unresolved：Actual shard paths and per-shard repair manifests still need operator selection; apply must remain separately authorized after a successful dry-run

### 2026-07-16T14:03:23.998Z · closeout · /root/corpus_import_gate

- Scope：Closed implementation of the local remote OCR receiver gate and handed the two scoped files back to the parent agent
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-receiver.test.mjs`
- Evidence：Default mode is non-writing dry-run; apply stages and renames whole document trees, writes form-feed joined text, archives exact source and repair evidence, records rollback actions, rechecks local ownership, and verifies repeated identical imports idempotently
- Rollback：Delete only these two untracked files if the receiver is rejected; no existing source file or live resource was changed by this subtask
- Unresolved：No D1 R2 Worker Pages report update deployment or real OCR production mutation occurred; parent retains responsibility for end-to-end import and site integration

</details>

<details><summary><code>curriculum-page-publication-gate-20260716</code> · 4 events · 2026-07-16T14:06:12.095Z → 2026-07-16T14:21:37.550Z</summary>

Agents：`/root/page_publication_gate`
Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/build-corpus.mjs`、`/Users/ylsuen/CF/curriculum-atlas/src/index.ts`、`/Users/ylsuen/CF/curriculum-atlas/migrations/0005_page_publication_gate.sql`、`/Users/ylsuen/CF/curriculum-atlas/data/page-publication-manifest.schema.json`、`/Users/ylsuen/CF/curriculum-atlas/tests/page-publication-gate.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/page-publication-gate.mjs`、`/Users/ylsuen/CF/curriculum-atlas/data/page-publication-manifest.json`、`/Users/ylsuen/CF/curriculum-atlas/tests/worker-health-taxonomy.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas`、`/private/tmp/curriculum-page-gate-build-20260716`、`/private/tmp/curriculum-page-gate-accepted-20260716`、`/private/tmp/curriculum-page-gate-d1-20260716`

### 2026-07-16T14:06:12.095Z · start · /root/page_publication_gate

- Scope：Implement fail-closed OCR page and paragraph publication gates only; exclude OCR receiver repair supervisor, frontend app.js, deployment, remote D1, and canonical report
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/build-corpus.mjs`、`/Users/ylsuen/CF/curriculum-atlas/src/index.ts`、`/Users/ylsuen/CF/curriculum-atlas/migrations/0005_page_publication_gate.sql`、`/Users/ylsuen/CF/curriculum-atlas/data/page-publication-manifest.schema.json`、`/Users/ylsuen/CF/curriculum-atlas/tests/page-publication-gate.test.mjs`
- Evidence：Git main is ahead one with unrelated OCR files dirty; no active task owns the scoped builder API migration schema or focused test; parent explicitly delegated this disjoint scope
- Rollback：Restore the two existing files from task-scoped prechange copies and remove only new migration schema and test files; no live or remote data changes are authorized
- Unresolved：Need define accepted page-manifest contract preserve native text imports hide closed paragraphs and run focused plus full tests

### 2026-07-16T14:13:51.396Z · change · /root/page_publication_gate

- Scope：Added a page-manifest-bound fail-closed publication layer for OCR corpus rows and filtered document-detail output; no live database or deployment mutation
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/build-corpus.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/page-publication-gate.mjs`、`/Users/ylsuen/CF/curriculum-atlas/data/page-publication-manifest.json`、`/Users/ylsuen/CF/curriculum-atlas/data/page-publication-manifest.schema.json`、`/Users/ylsuen/CF/curriculum-atlas/migrations/0005_page_publication_gate.sql`、`/Users/ylsuen/CF/curriculum-atlas/src/index.ts`、`/Users/ylsuen/CF/curriculum-atlas/tests/page-publication-gate.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/worker-health-taxonomy.test.mjs`
- Evidence：OCR documents are skipped before cache text read unless an accepted complete page manifest exists; exact source page final-text and evidence hashes are bound to every OCR paragraph; migration defaults display and citation closed and opens only legacy official native rows; API query requires display_allowed=1; focused 12 of 12 and TypeScript pass
- Rollback：Restore build-corpus.mjs and src/index.ts from checksummed task prechange copies; revert the focused worker-health test; remove only the new helper manifest schema migration and page-gate test files; no remote rollback is needed
- Unresolved：Need isolated full corpus build and migration/import proof plus complete npm test; accepted OCR manifest is intentionally empty until parent quality gates produce reviewed page evidence

### 2026-07-16T14:21:29.120Z · verify · /root/page_publication_gate

- Scope：Verified page publication schema builder migration and document-detail API entirely in local and isolated fixtures; no Cloudflare D1 or deployment write
- Resources：`/Users/ylsuen/CF/curriculum-atlas`、`/private/tmp/curriculum-page-gate-build-20260716`、`/private/tmp/curriculum-page-gate-accepted-20260716`、`/private/tmp/curriculum-page-gate-d1-20260716`
- Evidence：Full npm test passes 161 of 161; focused page corpus health tests pass 11 of 11; TypeScript syntax diff checks and Wrangler 4.110 dry-run pass; real native corpus build has 16456 displayed paragraphs and 93 unaccepted OCR documents skipped before text read; accepted nine-page fixture imports one displayed eight closed zero citable with nine complete provenance rows; fresh migration preserves native visibility closes legacy and default-insert OCR citation; local API health v9 schema 3 classification 1 page-publication 1 and unaccepted moe-2022-08 returns zero paragraphs while native detail returns provenance with private no-store
- Rollback：No production rollback applies; source rollback uses checksummed prechange copies for build-corpus and index plus removal of new scoped files and focused test reversion
- Unresolved：Parent must populate the intentionally empty accepted page manifest only after whole-document quality review; apply migration before v9 Worker because health and queries require the new schema; regenerate corpus SQL before any future import; no remote D1 deploy report or app.js change was made

### 2026-07-16T14:21:37.550Z · closeout · /root/page_publication_gate

- Scope：Hand off the complete fail-closed page publication gate implementation to the parent; source only with no deployment or shared-report mutation
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/build-corpus.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/page-publication-gate.mjs`、`/Users/ylsuen/CF/curriculum-atlas/data/page-publication-manifest.json`、`/Users/ylsuen/CF/curriculum-atlas/data/page-publication-manifest.schema.json`、`/Users/ylsuen/CF/curriculum-atlas/migrations/0005_page_publication_gate.sql`、`/Users/ylsuen/CF/curriculum-atlas/src/index.ts`、`/Users/ylsuen/CF/curriculum-atlas/tests/page-publication-gate.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/worker-health-taxonomy.test.mjs`
- Evidence：Fail-closed contract is implemented and independently reproducible: manifest absence skips OCR text, hash drift aborts builds, database defaults and triggers close display or citation, API hides closed paragraphs, native corpus remains visible, all 161 tests pass
- Rollback：Restore task prechange copies with SHA 0ac059e2 for build-corpus and 1fa8aca0 for index; remove six new scoped files and revert the focused worker-health test; no external state needs rollback
- Unresolved：Accepted OCR publication data remains deliberately empty; parent owns generation from reviewed OCR evidence, migration and corpus sequencing, deployment and live cache or browser verification

</details>

<details><summary><code>curriculum-remote-ocr-status-contract-20260716</code> · 3 events · 2026-07-16T14:06:50.698Z → 2026-07-16T14:12:50.095Z</summary>

Agents：`/root/remote_status_reconcile`
Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/run-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-runner.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`DMITPro2 inner bdfz r6 shard copies`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-receiver.test.mjs`

### 2026-07-16T14:06:50.698Z · start · /root/remote_status_reconcile

- Scope：Read-only contract audit of remote OCR run status, document status, repair provenance and receiver acceptance; implement only if a real gap exists; excludes receiver, repair, supervisor, public, source, corpus, deploy and report mutations
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/run-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-runner.test.mjs`
- Evidence：Parent delegated exclusive ownership of runner or a narrow reconciliation script; current worktree and action log show no overlapping owner for this scope; r5 and r6 production-like outputs remain outside this local inspection
- Rollback：If code becomes necessary, keep it task-scoped and revert only those files; current contract audit itself changes no OCR or production data
- Unresolved：Need prove quarantined plus independently repaired documents pass exact receiver gates without rewriting Paddle provenance and provide all-shard validation commands

### 2026-07-16T14:12:41.128Z · verify · /root/remote_status_reconcile

- Scope：Verified the existing remote OCR status and receiver contracts; no reconciliation write was needed or performed
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/run-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`DMITPro2 inner bdfz r6 shard copies`
- Evidence：Focused receiver repair gate passes 10 of 10 and runner recovery subset passes 4 of 4; syntax and diff checks pass; remote r6 A and B each remain settled with 34 complete and 2 quarantined documents; the four quarantine status files preserve attempt-budget failure evidence and citation_allowed false
- Rollback：No source OCR state or production data changed; no rollback required
- Unresolved：After repair apply and local shard transfer, run the receiver default dry-run and assert 72 documents, 5483 pages, 6 repair pages, 68 complete source statuses, 4 quarantined source statuses and citation_allowed false before any apply

### 2026-07-16T14:12:50.095Z · closeout · /root/remote_status_reconcile

- Scope：Closed read-only remote OCR status-contract audit with the existing fail-closed receiver path retained unchanged
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/run-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-receiver.test.mjs`
- Evidence：No task-owned source files changed; quarantined plus independently repaired is the intended receivable state, while quarantine without exact repair manifest receipt evidence remains rejected
- Rollback：None; read-only inspection and temporary test fixtures only
- Unresolved：Real r6 validation remains a parent-owned execution step after the six repair receipts exist and both shard trees are staged locally

</details>

<details><summary><code>curriculum-subject-facet-unification-20260716</code> · 4 events · 2026-07-16T14:23:54.919Z → 2026-07-16T14:37:30.222Z</summary>

Agents：`/root/subject_facet_unification`
Resources：`/Users/ylsuen/CF/curriculum-atlas/public/app.js`、`/Users/ylsuen/CF/curriculum-atlas/public/subject-facets.js`、`/Users/ylsuen/CF/curriculum-atlas/tests/subject-facet-unification.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/subject-facets.test.mjs`

### 2026-07-16T14:23:54.919Z · start · /root/subject_facet_unification

- Scope：Unify curriculum-atlas frontend display facets and query expansion only; exclude src index corpus OCR migrations deploy D1 report and shared hubs
- Resources：`/Users/ylsuen/CF/curriculum-atlas/public/app.js`、`/Users/ylsuen/CF/curriculum-atlas/public/subject-facets.js`、`/Users/ylsuen/CF/curriculum-atlas/tests/subject-facet-unification.test.mjs`
- Evidence：No active overlapping owner for public app.js or the new focused helper and test; current worktree contains unrelated delegated OCR corpus and backend changes that remain preserved
- Rollback：Restore only public/app.js from a task-scoped prechange copy and remove only the new helper and focused test if rejected; no live state is authorized
- Unresolved：Need inspect current API and frontend contracts then implement twelve controlled facets zero leakage hide-all and canonical-label preservation

### 2026-07-16T14:37:11.067Z · change · /root/subject_facet_unification

- Scope：Implemented frontend-only twelve-facet subject controls and exact canonical query expansion; preserved backend OCR corpus migrations deploy D1 reports and shared hubs
- Resources：`/Users/ylsuen/CF/curriculum-atlas/public/app.js`、`/Users/ylsuen/CF/curriculum-atlas/public/subject-facets.js`、`/Users/ylsuen/CF/curriculum-atlas/tests/subject-facets.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/subject-facet-unification.test.mjs`
- Evidence：Selectors now expose exactly twelve controlled display facets; foreign languages politics and technology expand to exact canonical identities; science routes to 科学类; compare search and AI preserve canonical labels and edition identity; assessment-only 汉语 is not queryable; hide-all suppresses every episode class
- Rollback：Restore public/app.js from /private/tmp/curriculum-subject-facet-unification-20260716/app.js.prechange and remove only the new subject-facets helper plus focused test; revert only the scoped subject-facets test changes
- Unresolved：No deployment authorized; production owner must bump the app asset version before deploy so cached app.js cannot omit the new module import

### 2026-07-16T14:37:21.742Z · verify · /root/subject_facet_unification

- Scope：Verified scoped frontend subject-facet unification without browser or live-state mutation
- Resources：`/Users/ylsuen/CF/curriculum-atlas/public/app.js`、`/Users/ylsuen/CF/curriculum-atlas/public/subject-facets.js`、`/Users/ylsuen/CF/curriculum-atlas/tests/subject-facets.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/subject-facet-unification.test.mjs`
- Evidence：Focused frontend and contract suite passes 26 of 26; full npm test passes 166 of 166; npm run check passes; node syntax checks and scoped diff whitespace checks pass; repository search finds no frontend 全部学科 label
- Rollback：No external state changed; source-only rollback remains the task prechange app.js copy plus removal or reversion of the three scoped helper and test artifacts
- Unresolved：Browser production verification remains deployment-owner work after asset cache version bump

### 2026-07-16T14:37:30.222Z · closeout · /root/subject_facet_unification

- Scope：Handed off completed frontend-only subject display-facet unification with all unrelated concurrent work preserved
- Resources：`/Users/ylsuen/CF/curriculum-atlas/public/app.js`、`/Users/ylsuen/CF/curriculum-atlas/public/subject-facets.js`、`/Users/ylsuen/CF/curriculum-atlas/tests/subject-facets.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/subject-facet-unification.test.mjs`
- Evidence：Twelve stable facets drive star-map controls compare sources and AI; exact canonical member calls retain subject and version identity; hide-all is atomic and cross-subject leakage tests pass; 166 of 166 full tests pass
- Rollback：No production rollback required because no deploy database or data mutation occurred; scoped source rollback is checksummed and documented
- Unresolved：Before production deployment bump the versioned app.js reference in index.html; grouped AI facets intentionally use one exact evidence-bounded AI request per evidenced canonical member and therefore consume the existing per-user quota proportionally

</details>

<details><summary><code>curriculum-concept-publication-gate-20260716</code> · 4 events · 2026-07-16T14:28:51.526Z → 2026-07-16T14:42:45.770Z</summary>

Agents：`codex-concept-publication-gate`
Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/build-concept-evolution.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/validate-concept-evolution.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/concept-publication-gate.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/concept-page-publication.mjs`、`/private/tmp/concept-gate-core.json`、`/private/tmp/concept-gate-academic.json`、`/private/tmp/concept-gate-quality.json`、`/Users/ylsuen/CF/curriculum-atlas`

### 2026-07-16T14:28:51.526Z · start · codex-concept-publication-gate

- Scope：Align concept-evolution build and validation with the fail-closed page publication manifest; own only concept builder validator focused tests and narrow helpers; exclude frontend worker corpus migration OCR receiver supervisor deploy and reports
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/build-concept-evolution.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/validate-concept-evolution.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/concept-publication-gate.test.mjs`
- Evidence：Existing page-publication implementation task is closed; active frontend facet task owns disjoint files
- Rollback：Revert only task-owned concept gate source and tests; generated artifacts are not task-owned
- Unresolved：Need preserve native official concept model while excluding unaccepted OCR from all semantic and fingerprint calculations

### 2026-07-16T14:39:36.991Z · change · codex-concept-publication-gate

- Scope：Implemented fail-closed OCR page publication binding for concept generation and validation
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/build-concept-evolution.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/validate-concept-evolution.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/concept-page-publication.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/concept-publication-gate.test.mjs`
- Evidence：OCR display pages now bind exact source page final-text and evidence hashes; citation-false observations are partitioned from citation-ready frequency and relations; raw OCR completion state removed from concept revision
- Rollback：Revert only these four task-owned files; no generated artifact production data D1 or deployment was changed
- Unresolved：Checked-in concept artifacts remain parent-owned and must be rebuilt only after accepted page manifest population

### 2026-07-16T14:42:36.557Z · verify · codex-concept-publication-gate

- Scope：Verify fail-closed concept publication alignment in isolated outputs and the full repository test suite
- Resources：`/private/tmp/concept-gate-core.json`、`/private/tmp/concept-gate-academic.json`、`/private/tmp/concept-gate-quality.json`、`/Users/ylsuen/CF/curriculum-atlas`
- Evidence：Focused 6 of 6; full npm test 172 of 172; TypeScript check pass; isolated build and strict validator pass with 553 official-native episodes 475 relations and zero OCR-published pages under empty manifest; git diff check and node syntax checks pass
- Rollback：No production rollback required because no deploy database report or generated checked-in artifact changed
- Unresolved：Parent must populate accepted page manifest from reviewed OCR and rebuild checked-in graph artifacts before deployment

### 2026-07-16T14:42:45.770Z · closeout · codex-concept-publication-gate

- Scope：Hand off concept evolution page-publication gate implementation to the parent without generated artifact or production mutation
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/build-concept-evolution.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/validate-concept-evolution.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/concept-page-publication.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/concept-publication-gate.test.mjs`
- Evidence：All local code and isolated artifact gates pass; native official ontology preserved and OCR is fail-closed until page publication acceptance
- Rollback：Revert only the four task-owned files; remove isolated private tmp artifacts if desired
- Unresolved：Do not deploy stale checked-in concept artifacts; rebuild them after reviewed OCR pages are written to data page-publication-manifest json

</details>

<details><summary><code>curriculum-remote-ocr-receiver-native-assets-20260716</code> · 4 events · 2026-07-16T14:37:30.767Z → 2026-07-16T14:50:03.566Z</summary>

Agents：`/root/corpus_import_gate`
Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-receiver.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-remote-stage-read-only`、`DMITPro2 inner bdfz r6 shard copies read-only`

### 2026-07-16T14:37:30.767Z · start · /root/corpus_import_gate

- Scope：Fix the receiver shape validator for genuine native Paddle markdown asset trees discovered by the real 72-document dry-run; preserve strict repair mirror isolation and exclude all other source files deployment and live cache apply
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-receiver.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-remote-stage-read-only`
- Evidence：Parent reported ictr-043d90816a8b page 0007 has native markdown/page-0007.md plus imgs/img_in_image_box_245_322_1414_1925.jpg; existing validator admits only one mirror file and therefore rejects valid Paddle output
- Rollback：Revert only the follow-up edits in the two already assigned receiver files; real staged OCR trees remain read-only and no apply or deploy is authorized
- Unresolved：Need inspect the exact real result state and markdown tree binding then add focused native asset and repaired-page rejection tests

### 2026-07-16T14:49:47.174Z · change · /root/corpus_import_gate

- Scope：Updated the receiver to accept only verified native Paddle Markdown trees and geometry-bound JPG assets while retaining asset-free exact repair mirrors
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-receiver.test.mjs`
- Evidence：Native page mirrors must be byte-identical to content; asset names are restricted to four observed Paddle filename families; every asset is hashed and bound by label and bbox to parsing or layout result geometry; symlinks empty files extra directories unknown names missing references and repair-page assets fail closed
- Rollback：Revert only this follow-up edit in the two receiver files; remote r6 shards and local production cache were read-only
- Unresolved：Parent must rerun the complete 72-document receiver dry-run with the updated local script before authorizing any apply

### 2026-07-16T14:50:03.534Z · verify · /root/corpus_import_gate

- Scope：Verified the native Paddle asset receiver follow-up in focused full and remote read-only corpus checks; no real receiver apply or deployment occurred
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-receiver.test.mjs`、`DMITPro2 inner bdfz r6 shard copies read-only`
- Evidence：Receiver focused passes 30 of 30; receiver runner repair passes 71 of 71; TypeScript and syntax checks pass; full npm passes 182 of 182; remote census covers 5483 page mirrors with zero mismatch 1373 JPGs with zero filename or geometry mismatch 593 image references with zero missing targets and six repair pages with zero assets
- Rollback：No external rollback required; only the two assigned untracked source files changed and all write-path tests used temporary fixtures
- Unresolved：A real 72-document dry-run using this patched local receiver remains parent-owned before apply

### 2026-07-16T14:50:03.566Z · closeout · /root/corpus_import_gate

- Scope：Closed the native Paddle Markdown asset compatibility follow-up and returned the patched receiver and tests to the parent
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-receiver.test.mjs`
- Evidence：Normal Paddle pages now retain and audit original Markdown image trees; repaired pages remain exact evidence-bound text mirrors with no unbound native assets; source document tree and per-page native Markdown fingerprints remain deterministic for receipts and idempotence
- Rollback：Revert only this follow-up within the two assigned files if the stricter native asset contract is rejected; no live cache D1 R2 Worker Pages or deployment state changed
- Unresolved：Parent should rerun the staged 72-document dry-run and confirm expected 72 documents 5483 pages six repair pages and citation false before any apply

</details>

<details><summary><code>curriculum-mobile-workbench-layout-20260716</code> · 5 events · 2026-07-16T14:42:00.996Z → 2026-07-16T14:49:11.187Z</summary>

Agents：`/root/subject_facet_unification`
Resources：`/Users/ylsuen/CF/curriculum-atlas/public/styles.css`、`/Users/ylsuen/CF/curriculum-atlas/public/index.html`、`/Users/ylsuen/CF/curriculum-atlas/tests/mobile-workbench-layout.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/subject-facets.test.mjs`

### 2026-07-16T14:42:00.996Z · start · /root/subject_facet_unification

- Scope：Fix mobile curriculum workbench intrinsic overflow and overlay accessibility only; own public styles.css public index.html and one focused layout test; exclude app.js atlas.js src OCR corpus migrations deploy D1 reports and shared hubs
- Resources：`/Users/ylsuen/CF/curriculum-atlas/public/styles.css`、`/Users/ylsuen/CF/curriculum-atlas/public/index.html`、`/Users/ylsuen/CF/curriculum-atlas/tests/mobile-workbench-layout.test.mjs`
- Evidence：No active overlapping owner for scoped files; current styles and index are unchanged from checksummed task backups; 390x844 compare overflow is attributable to grid-item automatic minimum sizing around the horizontal version river
- Rollback：Restore styles.css and index.html from /private/tmp/curriculum-mobile-workbench-layout-20260716 and remove only the new focused test; no live state is authorized
- Unresolved：Need contain mobile intrinsic width keep the two-entry dock reachable above inspector and open workbench bump versioned assets then run focused and full verification

### 2026-07-16T14:44:20.502Z · change · /root/subject_facet_unification

- Scope：Applied mobile-only overlay accessibility and global intrinsic-width containment while preserving the full-canvas desktop composition; updated only scoped styles index and focused test
- Resources：`/Users/ylsuen/CF/curriculum-atlas/public/styles.css`、`/Users/ylsuen/CF/curriculum-atlas/public/index.html`、`/Users/ylsuen/CF/curriculum-atlas/tests/mobile-workbench-layout.test.mjs`
- Evidence：Workbench grid items and body now have zero automatic minimum width; version river owns horizontal scrolling; mobile inspector reserves 96 pixels for the two-entry research dock; an open workbench promotes only the right dock above the panel and hides era controls; styles app and subject-facets use version 20260716v12 with an import map and module preload
- Rollback：Restore the two checksummed files from /private/tmp/curriculum-mobile-workbench-layout-20260716 and remove only tests/mobile-workbench-layout.test.mjs; no external state changed
- Unresolved：Need full regression TypeScript syntax and scoped diff verification; parent retains live 390 by 844 browser QA and deployment

### 2026-07-16T14:48:52.319Z · change · /root/subject_facet_unification

- Scope：Aligned the existing frontend cache regression with the scoped versioned dependency graph without modifying app.js atlas.js or concept data
- Resources：`/Users/ylsuen/CF/curriculum-atlas/tests/subject-facets.test.mjs`
- Evidence：The test now requires styles app subject-facet import mapping and subject-facet preload to share version 20260716v12 while still requiring explicit atlas and concept graph cache versions; unchanged dependencies are no longer falsely required to adopt the app entry version
- Rollback：Restore tests/subject-facets.test.mjs from /private/tmp/curriculum-mobile-workbench-layout-20260716/subject-facets.test.mjs; no runtime or production state changed
- Unresolved：None in source contract; live responsive browser verification remains parent-owned

### 2026-07-16T14:48:59.120Z · verify · /root/subject_facet_unification

- Scope：Verified the mobile workbench layout and cache-loading contract locally without browser live-state build deployment or generated-asset mutation
- Resources：`/Users/ylsuen/CF/curriculum-atlas/public/styles.css`、`/Users/ylsuen/CF/curriculum-atlas/public/index.html`、`/Users/ylsuen/CF/curriculum-atlas/tests/mobile-workbench-layout.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/subject-facets.test.mjs`
- Evidence：Focused frontend layout and facet suite passes 29 of 29; full npm test passes 182 of 182 after concurrent receiver closeout; npm run check passes; import-map JSON parse node syntax scoped diff whitespace and asset-version readback all pass
- Rollback：No production rollback applies; restore the three backed-up existing files from /private/tmp/curriculum-mobile-workbench-layout-20260716 and remove only the new mobile layout test
- Unresolved：Parent must run 390 by 844 compare inspector alternate-workbench and desktop browser QA before deployment

### 2026-07-16T14:49:11.187Z · closeout · /root/subject_facet_unification

- Scope：Hand off completed source-only mobile workbench overflow overlay and asset-cache fix with the full-canvas desktop workspace preserved
- Resources：`/Users/ylsuen/CF/curriculum-atlas/public/styles.css`、`/Users/ylsuen/CF/curriculum-atlas/public/index.html`、`/Users/ylsuen/CF/curriculum-atlas/tests/mobile-workbench-layout.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/subject-facets.test.mjs`
- Evidence：At narrow widths the outer workspace remains viewport-bounded the version river alone scrolls horizontally the inspector clears the two-entry dock and an open workbench leaves both alternate workspace links reachable; all 182 repository tests pass
- Rollback：Restore backed-up styles index and subject-facets test and remove the new mobile layout test; no external resource database report deployment or generated dist changed
- Unresolved：Only parent-owned live browser QA asset build and deployment remain

</details>

<details><summary><code>curriculum-backend-integrity-p2-20260716</code> · 4 events · 2026-07-16T14:44:33.653Z → 2026-07-16T14:56:01.786Z</summary>

Agents：`codex-backend-integrity`
Resources：`/Users/ylsuen/CF/curriculum-atlas/src/index.ts`、`/Users/ylsuen/CF/curriculum-atlas/src/ai.ts`、`/Users/ylsuen/CF/curriculum-atlas/tests/backend-integrity.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas`

### 2026-07-16T14:44:33.653Z · start · codex-backend-integrity

- Scope：Harden curriculum comment referential integrity and AI sentence-level citation validation only; own src index comment creation src ai and focused tests; preserve existing page-publication edits auth rate limits and all unrelated files
- Resources：`/Users/ylsuen/CF/curriculum-atlas/src/index.ts`、`/Users/ylsuen/CF/curriculum-atlas/src/ai.ts`、`/Users/ylsuen/CF/curriculum-atlas/tests/backend-integrity.test.mjs`
- Evidence：Prior page-publication owner of src index is closed; active mobile and frontend tasks own disjoint public files
- Rollback：Revert only task-owned validation additions and focused tests; no migration database deploy report or production resource will change
- Unresolved：Need deterministic factual-line classification that rejects uncited factual assertions without blocking headings explicit uncertainty or formatting

### 2026-07-16T14:56:01.733Z · change · codex-backend-integrity

- Scope：Added fail-closed comment reference integrity and sentence-level AI citation enforcement without changing auth rate limits migrations frontend OCR corpus or production
- Resources：`/Users/ylsuen/CF/curriculum-atlas/src/index.ts`、`/Users/ylsuen/CF/curriculum-atlas/src/ai.ts`、`/Users/ylsuen/CF/curriculum-atlas/tests/backend-integrity.test.mjs`
- Evidence：Parent comments must exist in the same document; paragraphs must exist in the same document and have display_allowed one; AI factual units require exact retrieved bracket citations with deterministic heading uncertainty suggestion and formatting exceptions
- Rollback：Revert only optionalParagraphId and createComment reference checks the AI validator integration and backend-integrity focused test file
- Unresolved：No deployment or data mutation performed

### 2026-07-16T14:56:01.760Z · verify · codex-backend-integrity

- Scope：Verified focused and complete curriculum backend integrity regression suite
- Resources：`/Users/ylsuen/CF/curriculum-atlas`
- Evidence：Focused backend integrity 26 of 26 passed; full npm test 208 of 208 passed; npm run check passed; git diff --check passed
- Rollback：No verification mutation to roll back
- Unresolved：Classifier intentionally defaults unusual nonempty prose table headers and unlabeled recommendations to factual and therefore citation-required

### 2026-07-16T14:56:01.786Z · closeout · codex-backend-integrity

- Scope：Closed backend P2 integrity hardening with source and focused tests complete
- Resources：`/Users/ylsuen/CF/curriculum-atlas/src/index.ts`、`/Users/ylsuen/CF/curriculum-atlas/src/ai.ts`、`/Users/ylsuen/CF/curriculum-atlas/tests/backend-integrity.test.mjs`
- Evidence：Rejected references do not consume the comment rate-limit budget; valid authenticated comments still use the existing limiter; AI rejection retains citation_validation_failed logging and current 502 response
- Rollback：Task changes are source-only and can be reverted file-surgically; no migration deploy remote state or canonical report changed
- Unresolved：Production behavior remains undeployed; deterministic language classification is conservative and future output formats should add tests before being exempted

</details>

<details><summary><code>curriculum-partial-doc-whole-reprocess-20260716</code> · 5 events · 2026-07-16T14:52:47.011Z → 2026-07-16T15:18:38.020Z</summary>

Agents：`/root/partial_doc_reprocess`
Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/plan-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/run-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-planner.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-receiver.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-runner.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/lib/remote-ocr-local-snapshot.mjs`

### 2026-07-16T14:52:47.011Z · start · /root/partial_doc_reprocess

- Scope：Implement source-only explicit opt-in planning and fail-closed receipt support for whole-document remote reruns of locally partial OCR documents; own planner receiver runner manifest validation and focused tests; exclude remote job start PDF transfer real cache apply public src concept corpus deploy D1 R2 reports and shared hubs
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/plan-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/run-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-planner.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-receiver.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-runner.test.mjs`
- Evidence：Current git status and action log inspected; prior receiver ownership is closed at 2026-07-16T14:50:03Z; no active overlapping owner remains for scoped files; existing dirty work outside scope will be preserved
- Rollback：Revert only task-owned source and test edits; no external or OCR production state mutation is authorized
- Unresolved：Need define deterministic local snapshot contract and exact atomic backup replacement while retaining default exclusion behavior

### 2026-07-16T15:11:02.986Z · change · /root/partial_doc_reprocess

- Scope：Implemented explicit per-document remote whole-rerun planning and fail-closed local replacement receipt paths without starting jobs transferring PDFs or applying to real OCR caches
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/lib/remote-ocr-local-snapshot.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/plan-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/run-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-planner.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-runner.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-receiver.test.mjs`
- Evidence：New mode requires repeated explicit --reprocess-document ids; snapshots state tree page artifacts text and scoped retry entries; apply fixtures atomically preserve original document trees in receipt backups, archive and clear owned retries, support exact rollback, and retain citation false
- Rollback：Revert only the seven task-owned source and test artifacts; all apply and rollback exercises used temporary fixtures and no real cache remote job PDF transfer deployment or external resource changed
- Unresolved：Need final focused rerun and handoff; full suite currently includes an unrelated active ocr-supervisor edit that breaks its watchdog structural test

### 2026-07-16T15:18:17.382Z · change · /root/partial_doc_reprocess

- Scope：Tightened the new receiver destination-root boundary and stabilized its wall-time escalation regression without changing production timeout policy
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-receiver.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-runner.test.mjs`
- Evidence：Destination roots now resolve through existing parents before containment and overlap checks; an outside-project symlink fixture is rejected before validation or writes; wall-time test retains TERM-to-KILL semantics with enough startup margin under full parallel load
- Rollback：Revert only these task-owned source and test edits; no remote OCR job transfer real cache receipt or production resource was changed by this subtask
- Unresolved：None in the source implementation; actual 14-document transfer run and later receipt apply remain parent-owned explicit operations

### 2026-07-16T15:18:25.887Z · verify · /root/partial_doc_reprocess

- Scope：Verified the explicit existing-local-document whole-rerun planner runner validator receiver rollback and idempotence loop using fixtures plus the current exact 14-document local snapshot
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/lib/remote-ocr-local-snapshot.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/plan-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/run-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-planner.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-runner.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-receiver.test.mjs`
- Evidence：Full npm test passes 226 of 226; TypeScript and four script syntax checks pass; focused planner and receiver pass 48 of 48 and runner passes 28 of 28; current read-only 14-document manifest validates 6364 pages 1464 locally completed pages 340796129 source bytes one page retry all snapshot hashes valid and all citation flags false
- Rollback：Source-only rollback is file-surgical; every apply rollback repeated-apply drift and mixed-failure exercise used temporary fixtures and retained exact original trees text and retry ledgers
- Unresolved：No remote OCR job was started and no PDF was transferred or real cache applied by this subtask; those remain explicit parent-owned operations gated by the generated exact snapshot

### 2026-07-16T15:18:38.020Z · closeout · /root/partial_doc_reprocess

- Scope：Handed off a fail-closed explicit opt-in whole-document rerun and replacement receipt loop for the 14 existing local OCR documents while preserving all original partial work
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/lib/remote-ocr-local-snapshot.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/plan-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/run-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-planner.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-runner.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-offload-receiver.test.mjs`
- Evidence：Explicit selection binds exact local state tree text and retry snapshots; receiver rejects drift missing pages tampering aliases and citation eligibility; apply preserves original trees in receipt backups clears only owned retries supports dry-run idempotent repeat and exact rollback; repository suite is green
- Rollback：Revert only the seven listed task-owned files or use a generated receipt rollback after a future authorized apply; no real cache was changed here so no operational rollback is presently required
- Unresolved：Parent must keep the local OCR owner held when generating the final manifest and must dry-run the receiver against complete remote results before any authorized apply; legacy 72-document receipt remains separate and untouched

</details>

<details><summary><code>curriculum-r6-vision-evidence-backfill-20260716</code> · 15 events · 2026-07-16T15:01:37.340Z → 2026-07-17T02:04:06.232Z</summary>

Agents：`root`、`codex-root`
Resources：`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-witness`、`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-supervisor`、`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-production`、`/Users/ylsuen/CF/curriculum-atlas/.cache/remote-ocr-offload/20260716-r6/manifests/offload-manifest.json`、`ictr-043d90816a8b`、`.cache/ocr-witness/ictr-043d90816a8b`、`.cache/ocr-supervisor`、`run:2026-07-16T15-01-41-323Z-4546131b`、`.cache/ocr-supervisor/logs/2026-07-16T15-01-41-323Z-4546131b/vision.log`、`ictr-043d90816a8b:page-1`、`.cache/ocr-supervisor/page-retries.json`、`scripts/ocr-supervisor.mjs:srunLogged`、`/private/tmp/vision-diagnose`、`.cache/ocr-witness/ictr-043d90816a8b/images/page-001.png`、`scripts/ocr-supervisor.mjs:backfill-evidence`、`.cache/remote-ocr-offload/20260716-r6/manifests/offload-manifest.json`、`.cache/ocr-witness`、`scripts/ocr-supervisor.mjs`、`tests/ocr-supervisor-evidence-drain.test.mjs`、`curriculum-atlas/scripts/ocr-supervisor.mjs`、`/private/tmp/vision-diagnose/helper-v3.log`、`.cache/ocr-audits`、`curriculum-atlas/.cache/ocr-supervisor`、`curriculum-atlas/.cache/ocr-witness`、`curriculum-atlas/.cache/ocr-witness/ictr-043d90816a8b`、`curriculum-atlas/.cache/ocr-supervisor/page-retries.json`、`curriculum-atlas/.cache/ocr-supervisor/drain-state.json`、`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-supervisor/drain-state.json`、`curriculum-atlas/tests/ocr-supervisor-evidence-drain.test.mjs`

### 2026-07-16T15:01:37.340Z · start · root

- Scope：Begin Mac Apple Vision witness and audit backfill for only the 72 imported r6 documents; preserve main OCR ownership of the remaining 14 partial documents and keep citation fail-closed
- Resources：`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-witness`、`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-supervisor`、`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-production`、`/Users/ylsuen/CF/curriculum-atlas/.cache/remote-ocr-offload/20260716-r6/manifests/offload-manifest.json`
- Evidence：Imported set is exact 72 documents and 5483 completed pages; supervisor next batch is witness_backfill; watchdog is held with no child; 69.08 GiB free and estimated witness growth is approximately 2 GiB from existing density
- Rollback：Delete only newly generated witness audit and candidate-run artifacts after their exact run ids are recorded; imported primary OCR receipt is separate and remains unchanged
- Unresolved：Need canary batch and a manifest-bounded evidence-only drain before the full witness set can be trusted

### 2026-07-16T15:01:37.369Z · change · root

- Scope：Run a single explicit 39-page Apple Vision and audit canary for the first imported document only; no primary OCR or llama invocation is allowed by witness_backfill mode
- Resources：`ictr-043d90816a8b`、`.cache/ocr-witness/ictr-043d90816a8b`、`.cache/ocr-supervisor`
- Evidence：Current next batch mode witness_backfill pages 1 through 39; document primary state already complete and hash-validated by receiver
- Rollback：Remove only artifacts associated with the resulting run id after hash review if the canary fails; primary OCR tree and receipt remain immutable
- Unresolved：Canary must prove all 39 pages witnessed and audited with no Paddle stage before scaling

### 2026-07-16T15:05:18.809Z · verify · root

- Scope：Fail-closed the first 39-page Apple Vision canary after a systemic macOS Vision service error; primary OCR and citation state remained untouched
- Resources：`run:2026-07-16T15-01-41-323Z-4546131b`、`.cache/ocr-supervisor/logs/2026-07-16T15-01-41-323Z-4546131b/vision.log`、`ictr-043d90816a8b`
- Evidence：39 of 39 pages returned Foundation._GenericObjCError across four attempts; zero audits; zero witness sidecars installed; owned_llama_pid null and paddle_exit_code null; run partial_failed; later isolated one-page and 39-page direct Vision probes on the same rendered files both succeeded, proving a transient process or service incident rather than corrupt input
- Rollback：No primary data rollback required; retain failed run and retry ledger as evidence; temporary standalone probe outputs can be discarded after root-cause proof
- Unresolved：Run one forced single-page supervisor recovery canary before resuming; do not bulk retry while system behavior is unproven

### 2026-07-16T15:05:18.835Z · change · root

- Scope：Run exactly one forced page-level Vision recovery canary for the failed document after direct same-image Vision probes recovered
- Resources：`ictr-043d90816a8b:page-1`、`.cache/ocr-supervisor/page-retries.json`
- Evidence：Direct single-page and full 39-page standalone Vision calls now return valid lines with no error; retry remains fail-closed and is limited to one page
- Rollback：If the page fails again retain its quarantine and stop; if it succeeds keep the valid witness and audit bound to the exact PDF and rendered image hashes
- Unresolved：Need prove supervisor-side single-page recovery and audit before clearing the systemic incident

### 2026-07-16T15:07:42.060Z · verify · root

- Scope：Reproduced the Apple Vision failure as a deterministic child stdio contract bug rather than an OCR or image-quality defect
- Resources：`scripts/ocr-supervisor.mjs:srunLogged`、`/private/tmp/vision-diagnose`、`.cache/ocr-witness/ictr-043d90816a8b/images/page-001.png`
- Evidence：Same Swift script image and zh-Hans,en-US profile: direct shell succeeds; Node spawn with stdout and stderr pipes succeeds with 5 lines; Node spawn with both outputs bound directly to a regular log fd exits zero but Vision returns Foundation._GenericObjCError and zero lines. A standalone 39-image pipe run also passes 39 of 39.
- Rollback：No production data changed; remove only diagnostic-direct diagnostic-node-spawn diagnostic-node-pipe folders and private tmp outputs after the patched supervisor passes its recovery canary
- Unresolved：Patch Vision subprocess logging to pipe through the Node parent, then retry one page before batch scaling

### 2026-07-16T15:16:36.118Z · change · root

- Scope：Start the manifest-bounded evidence-only drain for exactly the imported 72 documents after fixing the Swift child stdio contract; retain one-page recovery canary before automatic batch scaling
- Resources：`scripts/ocr-supervisor.mjs:backfill-evidence`、`.cache/remote-ocr-offload/20260716-r6/manifests/offload-manifest.json`、`.cache/ocr-witness`、`.cache/ocr-supervisor`
- Evidence：New evidence-only command passed 225 repository tests and real 72-document 5483-page primary preflight; Vision subprocess pipe proof succeeds; command rejects primary new full or recovery modes and does not invoke Paddle llama or concept builds; existing 39 retry pages force a one-page canary
- Rollback：Interrupt only the owned evidence drain; retain completed hash-bound witness and audit pages, or remove exact run artifacts if later invalidated; primary OCR receipt remains separate
- Unresolved：Need observe the first canary audit success then monitor all 5483 pages to completion and quality-gate every result

### 2026-07-16T15:23:12.862Z · verify · root

- Scope：Confirmed the final Vision logging fix buffers child output without any run-time file write and fails closed above 8 MiB
- Resources：`scripts/ocr-supervisor.mjs`、`tests/ocr-supervisor-evidence-drain.test.mjs`
- Evidence：Minimal reproduction shows run-time FileHandle.write causes Foundation GenericObjCError; final implementation writes zero log bytes while child is alive and flushes only after exit; overflow terminates and rejects; full test suite 227 of 227
- Rollback：Revert only the final bounded-buffer helper if rejected; no OCR result or remote state changed by tests
- Unresolved：One real page recovery canary remains required before full evidence drain

### 2026-07-16T15:23:12.887Z · change · root

- Scope：Retry the evidence-only drain with its mandatory one-page recovery canary after the final Apple Vision logging fix
- Resources：`ictr-043d90816a8b:page-1`、`.cache/ocr-supervisor/page-retries.json`
- Evidence：Page has three recorded fail-closed Vision attempts and is not quarantined; command scope remains exact 72-document manifest and cannot invoke primary OCR Paddle llama or concept builds
- Rollback：Stop immediately and retain retry evidence if the one-page canary does not produce a hash-bound witness and audit
- Unresolved：Canary must audit successfully before automatic 64-page batches are permitted

### 2026-07-16T15:31:08.216Z · verify · root

- Scope：Validated the production-exported Apple Vision child wrapper on a real imported page after lazy log open
- Resources：`curriculum-atlas/scripts/ocr-supervisor.mjs`、`ictr-043d90816a8b:page-1`、`/private/tmp/vision-diagnose/helper-v3.log`
- Evidence：Swift exited zero in 694 ms; pipe capture held 269 bytes in memory; post-exit flush succeeded; JSON sidecar has five OCR lines and no Vision error; task log was created only after child and streams ended
- Rollback：Diagnostic output is isolated under diagnostic-helper-v3 and can be removed after the supervised canary; no retry state or corpus artifact changed
- Unresolved：Page 1 has four recorded failures, so the supervised evidence canary is the final pre-quarantine attempt and must fail closed on any mismatch

### 2026-07-16T15:31:08.241Z · change · root

- Scope：Start manifest-bounded evidence-only recovery with mandatory one-page Vision canary, then 64-page batches only after audit success
- Resources：`.cache/remote-ocr-offload/20260716-r6/manifests/offload-manifest.json`、`.cache/ocr-supervisor/page-retries.json`、`.cache/ocr-witness`、`.cache/ocr-audits`
- Evidence：Real wrapper diagnostic passed; command is restricted to imported 72-document manifest, witness_backfill and audit_backfill, and cannot run Paddle llama primary OCR or concept generation
- Rollback：Interrupt at first failure; retain the failed sidecar and retry record; do not advance to batch mode unless page 1 produces a hash-bound witness and audit
- Unresolved：Existing unrelated chemistry page 84 Paddle quarantine remains fail-closed and is not touched by this evidence-only command

### 2026-07-16T16:15:07.807Z · change · root

- Scope：Launch the manifest-scoped Apple Vision evidence-only drain outside the Codex macOS sandbox, beginning with the quarantined one-page canary
- Resources：`curriculum-atlas/.cache/ocr-supervisor`、`curriculum-atlas/.cache/ocr-witness`、`.cache/remote-ocr-offload/20260716-r6/manifests/offload-manifest.json`
- Evidence：Sandbox root cause is exact: identical launcher fails only inside seatbelt and returns 5 lines outside; launcher race fix passes 41 focused and 252 full tests; manifest SHA 3050f22e and scope is 72 documents 5483 pages; prestart retry/drain/page-one evidence snapshot stored under /private/tmp/curriculum-vision-backfill-prestart-20260716T1615Z
- Rollback：Interrupt the single evidence drain; restore only the prestart retry/drain/page-one files if the canary corrupts state; source PDFs and primary OCR stay unchanged, no llama/Paddle/build is permitted in evidence mode
- Unresolved：Must verify canary clears only ictr-043d90816a8b page 1 vision retry and creates a schema-3 valid witness before accepting continuous 64-page batches

### 2026-07-16T16:16:50.735Z · verify · root

- Scope：Accepted the unsandboxed Apple Vision canary and first two continuous evidence batches after checking retry cleanup, signed witness schema, audit output, and process boundary
- Resources：`curriculum-atlas/.cache/ocr-witness/ictr-043d90816a8b`、`curriculum-atlas/.cache/ocr-supervisor/page-retries.json`、`curriculum-atlas/.cache/ocr-supervisor/drain-state.json`
- Evidence：Canary page 1 produced schema 3 witness with launcher SHA 6d046470, 5 lines, citation false; vision retry key cleared; audit ran and remained unresolved_fail_closed at 0.83871 agreement; drain then completed remaining 38 pages of first document and all 45 pages of second with zero page failures, 3 batches total; process inspection shows only supervisor launcher and Swift, no Paddle or llama
- Rollback：Interrupt the one drain; retain derived witnesses and audits for diagnosis or restore the exact prestart page-one and retry snapshot if canary state is rejected; primary OCR and source PDFs are unchanged
- Unresolved：Continue 64-page evidence batches and fail immediately on any page failure, disk boundary, lock drift, or launcher/XPC regression; audit result is evidence only and does not open publication

### 2026-07-16T16:23:12.501Z · verify · root

- Scope：Continue the exclusive unsandboxed Apple Vision evidence drain after the canary
- Resources：`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-supervisor/drain-state.json`、`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-witness`
- Evidence：Drain reached 660 pages across 17 completed batches with matching new Vision witness and audit counts, no reported page failures, exclusive lock intact, Apple Vision only runtime policy and derived builds disabled
- Rollback：Interrupt only PTY session 37665 and its owned supervisor process if a page failure or lock drift occurs; preserve the prestart backup
- Unresolved：Evidence completion does not imply publication acceptance; unresolved audits remain fail closed and require later image and same edition online review

### 2026-07-16T17:21:17.991Z · verify · codex-root

- Scope：Verified terminal completion and post-run invariants for the manifest-scoped exclusive Apple Vision evidence drain
- Resources：`curriculum-atlas/.cache/ocr-supervisor/drain-state.json`、`curriculum-atlas/.cache/ocr-witness`、`.cache/remote-ocr-offload/20260716-r6/manifests/offload-manifest.json`
- Evidence：Terminal code EVIDENCE_SCOPE_COMPLETE; 72 documents, 5,483 audited pages, 123 batches, completed_at 2026-07-16T17:15:41.216Z, 62.85 GiB free; exclusive lock released; no residual supervisor/launcher/Swift process; post-status witness_missing_for_completed 0, witness_error_sidecars 0, stale_audit_pages 0
- Rollback：Evidence is additive derived data; preserve it for audit or restore only the exact prestart retry/drain/page-one snapshot if a later integrity verifier finds scoped corruption; source PDFs and primary OCR were unchanged
- Unresolved：Independent manifest verifier and full repository suite still pending; all pages remain non-citable because critical-field declarations are absent and review gates are fail closed

### 2026-07-17T02:04:06.232Z · closeout · codex-root

- Scope：Close the completed manifest-scoped Apple Vision evidence drain and transfer its supervisor source and regression test to the full release
- Resources：`curriculum-atlas/scripts/ocr-supervisor.mjs`、`curriculum-atlas/tests/ocr-supervisor-evidence-drain.test.mjs`
- Evidence：The prior verifier recorded 72 documents 5483 pages 123 batches with zero missing error or stale evidence; current focused OCR tests pass
- Rollback：Preserve evidence manifests and revert only transferred source files if required
- Unresolved：Evidence completion does not open citation or display; semantic publication gates remain authoritative

</details>

<details><summary><code>curriculum-evidence-only-drain-20260716</code> · 4 events · 2026-07-16T15:02:29.130Z → 2026-07-16T15:15:36.186Z</summary>

Agents：`/root/evidence_backfill_runner`
Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/ocr-supervisor.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-supervisor-evidence-drain.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/.cache/remote-ocr-offload/20260716-r6/manifests/offload-manifest.json`

### 2026-07-16T15:02:29.130Z · start · /root/evidence_backfill_runner

- Scope：Implement a resumable Apple Vision witness and audit-only drain command scoped to completed OCR pages; exclude receiver planner remote OCR primary recovery new OCR concept publication frontend backend deploy D1 R2 and reports
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/ocr-supervisor.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-supervisor-evidence-drain.test.mjs`
- Evidence：Git status and action log inspected; no active owner overlaps the supervisor evidence-only command scope; current supervisor contains mixed scheduler paths that can enter primary recovery or new OCR and requires a separate fail-closed selector
- Rollback：Revert only task-owned supervisor edits and remove only the new focused test file; no long task cache production or external resource mutation is authorized
- Unresolved：Need define exact manifest scope validation evidence-only scheduling safe blocked completion and signal disk failure semantics

### 2026-07-16T15:12:51.768Z · change · /root/evidence_backfill_runner

- Scope：Added a manifest-scoped resumable evidence-only supervisor drain and corrected Apple Vision child logging without running the long backfill task
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/ocr-supervisor.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-supervisor-evidence-drain.test.mjs`
- Evidence：backfill-evidence accepts only witness_backfill and audit_backfill; primary new full or witness recovery modes block before execution; Paddle llama and derived concept builds are disabled; Vision batch and per-page retry use pipe capture then ordered log writes because regular-file child stdio reproducibly caused Foundation GenericObjCError; retry recovery begins with a one-page canary
- Rollback：Revert only the task-scoped supervisor additions and remove the new focused test; no OCR artifacts cache documents remote resources or deployment state were mutated
- Unresolved：Need run focused and full regressions and perform a non-long one-page operator canary only when the parent authorizes actual execution

### 2026-07-16T15:15:36.163Z · verify · /root/evidence_backfill_runner

- Scope：Verified the evidence-only supervisor path and Apple Vision pipe logging without starting any OCR drain
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/ocr-supervisor.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-supervisor-evidence-drain.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/.cache/remote-ocr-offload/20260716-r6/manifests/offload-manifest.json`
- Evidence：Focused supervisor tests pass 33 of 33; full npm test passes 225 of 225; TypeScript syntax and diff checks pass; actual manifest read-only primary integrity preflight passes 72 documents and 5483 pages; renderer SHA matches the pinned value; no long task was started
- Rollback：Revert only the evidence-only supervisor and Vision logging edits and remove the new focused test; existing OCR retry evidence remains preserved
- Unresolved：Parent may now run the explicit command with retry override; the first batch will be one page and any failed canary stops fail closed

### 2026-07-16T15:15:36.186Z · closeout · /root/evidence_backfill_runner

- Scope：Hand off the resumable manifest-scoped Apple Vision witness and audit-only drain implementation to the parent
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/ocr-supervisor.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-supervisor-evidence-drain.test.mjs`
- Evidence：Command requires explicit manifest or document scope, preserves shared locks signals 50 GiB warning and 25 GiB hard stop, records progress, retries only by explicit override, starts recovery with one-page canary, and never starts Paddle llama or concept derivation
- Rollback：Source-only rollback is file-surgical; no cache import witness audit remote process deployment database or report mutation was performed by this task
- Unresolved：Actual 5483-page evidence backfill remains parent-owned execution; existing 39 page Vision retry records are intentionally not cleared until each page succeeds and audits

</details>

<details><summary><code>curriculum-partial14-private-r2-transfer-20260716</code> · 10 events · 2026-07-16T15:11:37.812Z → 2026-07-16T15:49:05.985Z</summary>

Agents：`root`
Resources：`Cloudflare R2 temporary bucket:curriculum-ocr-transfer-20260716t1512z`、`DMITPro2 inner bdfz:/home/suen/curriculum-ocr-offload/input`、`14 exact queue source PDFs`、`R2:curriculum-ocr-transfer-20260716t1512z`、`R2:curriculum-ocr-transfer-20260716t1512z/transient/curriculum-ocr/20260716t1512z`、`/private/tmp/curriculum-r2-upload-logs`、`DMITPro2 inner bdfz:/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/input/pdfs-verified`、`/private/tmp/curriculum-r2-transfer-download.mjs`

### 2026-07-16T15:11:37.812Z · start · root

- Scope：Transfer the exact 14 queue-owned source PDFs to the managed inner workstation through a dedicated temporary private R2 bucket; exclude all cross-validation variants production source buckets and unrelated backup buckets
- Resources：`Cloudflare R2 temporary bucket:curriculum-ocr-transfer-20260716t1512z`、`DMITPro2 inner bdfz:/home/suen/curriculum-ocr-offload/input`、`14 exact queue source PDFs`
- Evidence：Exact queue manifest independently verified: 14 regular files 6364 pages 340796129 bytes SHA256 bad 0; math-b biology-b politics-b excluded; existing bdfz-ops-backups has other historical ownership so a dedicated bucket avoids overlap
- Rollback：Delete only the exact uploaded objects after remote checksum acceptance then delete the exact empty temporary bucket; local source PDFs remain read-only
- Unresolved：Need create private bucket upload exact objects issue minimal read-only transfer credentials remote download hash proof and full cleanup

### 2026-07-16T15:11:37.843Z · change · root

- Scope：Create only the dedicated empty private R2 transfer bucket before any source upload
- Resources：`R2:curriculum-ocr-transfer-20260716t1512z`
- Evidence：Bucket name absent from live list; no custom domain or production binding planned
- Rollback：Delete the exact bucket while empty if creation or privacy verification fails
- Unresolved：Must verify private controls before uploading any PDF

### 2026-07-16T15:12:27.603Z · verify · root

- Scope：Verified the dedicated transfer bucket is empty and private before source upload
- Resources：`R2:curriculum-ocr-transfer-20260716t1512z`
- Evidence：object_count 0 bucket_size 0; no custom domains; r2.dev public access disabled; dedicated bucket absent before task and has no Worker binding
- Rollback：Delete the exact empty bucket if upload does not proceed
- Unresolved：Exact 14-object upload and remote readback remain

### 2026-07-16T15:12:27.628Z · change · root

- Scope：Upload the exact 14 queue PDF objects to the dedicated private bucket with four bounded workers and application/pdf metadata
- Resources：`R2:curriculum-ocr-transfer-20260716t1512z/transient/curriculum-ocr/20260716t1512z`
- Evidence：Local exact manifest 14 files 340796129 bytes SHA256 bad 0; keys derived only from controlled document ids; no glob and cross-validation variants excluded
- Rollback：Delete only the 14 exact keys after validation or immediately on any partial failure; then delete the exact empty bucket
- Unresolved：Need inspect every upload exit status and verify object size/hash before any remote OCR use

### 2026-07-16T15:43:01.743Z · verify · root

- Scope：Verified completion of the exact 14-object private R2 upload before issuing any read credential
- Resources：`R2:curriculum-ocr-transfer-20260716t1512z/transient/curriculum-ocr/20260716t1512z`、`/private/tmp/curriculum-r2-upload-logs`
- Evidence：14 of 14 upload exits are zero; all 14 logs contain Upload complete and exact manifest-derived keys; no missing extra or mismatched log; local source SHA256 recheck matches all 14 files totaling 340796129 bytes
- Rollback：Objects remain confined to the dedicated temporary private bucket and will be deleted only after remote hash acceptance
- Unresolved：Remote object-scoped readback and exact destination hash validation remain

### 2026-07-16T15:43:01.767Z · change · root

- Scope：Transfer the exact 14 private R2 objects to the isolated inner-workstation run using one-hour object-read-only credentials and per-file SHA256 checks
- Resources：`R2:curriculum-ocr-transfer-20260716t1512z`、`DMITPro2 inner bdfz:/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/input/pdfs-verified`、`/private/tmp/curriculum-r2-transfer-download.mjs`
- Evidence：Remote destination is empty with zero symlinks; script validates locked manifest scope, never prints credentials or signed query strings, and supplies exact SHA256 checksums to aria2
- Rollback：Stop the transfer and remove only incomplete files under the new isolated input root if any checksum fails; no old run or local source is modified
- Unresolved：After transfer, independently enumerate exact 14 regular files and verify total bytes SHA256 PDF page counts and absence of extras before OCR start

### 2026-07-16T15:48:07.950Z · verify · root

- Scope：Accepted the remote source transfer only after independent exact-set and content validation
- Resources：`DMITPro2 inner bdfz:/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/input/pdfs-verified`
- Evidence：aria2 reported checksum verification success for all 14; remote validator returns ok true with 14 documents 6364 pages 340796129 bytes; independent sha256sum matches every locked manifest hash; exactly 14 regular mode-600 files, zero symlinks and zero other nodes
- Rollback：Remote input is isolated and immutable for the run; local original files remain unchanged; if later validation fails delete only this new input tree and repeat transfer
- Unresolved：Temporary R2 objects must now be securely removed and the dedicated bucket deleted; shard manifests and service preflight remain

### 2026-07-16T15:48:07.974Z · change · root

- Scope：Delete only the exact 14 verified transfer objects and then the dedicated empty temporary bucket
- Resources：`R2:curriculum-ocr-transfer-20260716t1512z/transient/curriculum-ocr/20260716t1512z`、`R2:curriculum-ocr-transfer-20260716t1512z`
- Evidence：Remote copies are exact and complete; cleanup scope is derived from the same locked 14-document manifest with no wildcard or prefix deletion
- Rollback：R2 cleanup is intentionally irreversible but safe because both local originals and exact remote verified copies remain; any failed deletion leaves the private bucket fail-closed for retry
- Unresolved：Must verify all exact deletes succeeded and the bucket no longer exists

### 2026-07-16T15:49:05.953Z · verify · root

- Scope：Verified exact transfer-object cleanup and dedicated bucket nonexistence after remote acceptance
- Resources：`R2:curriculum-ocr-transfer-20260716t1512z`、`DMITPro2 inner bdfz:/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/input/pdfs-verified`
- Evidence：All 14 exact object delete commands exited zero; bucket delete confirmed; subsequent bucket info returns Cloudflare code 10006 specified bucket does not exist; remote exact 14 mode-600 SHA256-verified sources remain
- Rollback：No R2 rollback is needed or possible after intentional cleanup; durable source truth exists in unchanged local originals plus the isolated verified remote copies
- Unresolved：None for transfer transport; remote OCR shard preparation and execution continue under the separate reprocess task

### 2026-07-16T15:49:05.985Z · closeout · root

- Scope：Close temporary private R2 transport after complete verified delivery and cleanup
- Resources：`R2:curriculum-ocr-transfer-20260716t1512z`、`DMITPro2 inner bdfz:/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/input/pdfs-verified`
- Evidence：End state: temporary bucket absent; 14 remote regular files total 340796129 bytes, exact SHA256 and 6364-page validator pass, zero extras symlinks or special nodes
- Rollback：Re-transfer from the unchanged local manifest-bound originals through a new dedicated private bucket if the isolated remote input is ever lost
- Unresolved：Transport complete; OCR quality and publication gates are intentionally outside this transfer closeout

</details>

<details><summary><code>curriculum-vision-postexit-log-buffer-20260716</code> · 4 events · 2026-07-16T15:20:05.395Z → 2026-07-16T15:22:33.528Z</summary>

Agents：`/root/evidence_backfill_runner`
Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/ocr-supervisor.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-supervisor-evidence-drain.test.mjs`

### 2026-07-16T15:20:05.395Z · start · /root/evidence_backfill_runner

- Scope：Correct Apple Vision pipe logging so no FileHandle write occurs while the Swift child is running; add bounded post-exit buffering and focused regressions only
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/ocr-supervisor.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-supervisor-evidence-drain.test.mjs`
- Evidence：Parent provided a second minimal reproduction proving asynchronous FileHandle writes during the Swift child lifetime still trigger Foundation GenericObjCError; prior evidence-only task is closed and this is a scoped continuation
- Rollback：Revert only the post-exit pipe-buffer helper changes and associated focused tests; no OCR execution cache or external mutation is authorized
- Unresolved：Need enforce an explicit bounded byte limit, fail closed on overflow, prove no live-child writes, and preserve ordinary regular-fd behavior

### 2026-07-16T15:22:33.476Z · change · /root/evidence_backfill_runner

- Scope：Changed Apple Vision child output capture from live asynchronous FileHandle writes to bounded in-memory buffering with one post-exit append
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/ocr-supervisor.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-supervisor-evidence-drain.test.mjs`
- Evidence：Vision batch and page retry have an explicit 8388608-byte cap; stdout and stderr data events only append Buffer chunks in memory; after both streams and child exit the ordered buffer is written once; overflow records CHILD_OUTPUT_BUFFER_LIMIT, terminates the child, writes only after exit, and rejects the run; regular-fd children are unchanged
- Rollback：Revert only the bounded post-exit capture helper and the new focused assertions; no long OCR task or artifact write was performed
- Unresolved：Need complete regression verification; parent retains actual one-page Apple Vision canary execution

### 2026-07-16T15:22:33.503Z · verify · /root/evidence_backfill_runner

- Scope：Verified post-exit-only Apple Vision logging and bounded overflow handling without launching OCR
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/ocr-supervisor.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-supervisor-evidence-drain.test.mjs`
- Evidence：Focused supervisor suite passes 34 of 34; full npm test passes 227 of 227; TypeScript syntax and diff checks pass; tests prove zero log bytes while the pipe child is alive, zero before explicit post-exit flush, complete output after flush, live regular-fd behavior unchanged, and byte-limit overflow fail closed
- Rollback：No runtime rollback required; source-only changes can be reverted file-surgically and tests use temporary directories
- Unresolved：No actual Vision/Paddle/llama process was launched by verification; parent should run the one-page canary before any long drain

### 2026-07-16T15:22:33.528Z · closeout · /root/evidence_backfill_runner

- Scope：Hand off corrected Apple Vision post-exit log buffering to the parent for one-page canary validation
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/ocr-supervisor.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-supervisor-evidence-drain.test.mjs`
- Evidence：The second minimal-reproduction condition is now encoded as a regression contract: no FileHandle.write can run during the Swift child lifetime; bounded output is appended exactly once after exit, and overflow cannot be mistaken for success
- Rollback：Revert the scoped helper and tests only; OCR retry records and imported corpus remain untouched
- Unresolved：Actual evidence backfill remains paused pending successful one-page canary under the corrected implementation

</details>

<details><summary><code>curriculum-partial14-remote-reprocess-20260716</code> · 19 events · 2026-07-16T15:20:21.258Z → 2026-07-17T02:04:06.511Z</summary>

Agents：`root`、`codex-root`
Resources：`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-production:14 selected documents`、`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-supervisor/page-retries.json`、`DMITPro2 inner bdfz isolated new run`、`/Users/ylsuen/CF/curriculum-atlas/.cache/remote-ocr-offload/20260716-partial14-reprocess-manifest.json`、`DMITPro2 inner bdfz:/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess`、`curriculum-atlas/.cache/remote-ocr-offload/20260716-partial14-reprocess-shards`、`DMITPro2 inner bdfz:/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/manifests`、`DMITPro2 inner bdfz:/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/input/pdfs-verified`、`DMITPro2 inner bdfz:/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p4-mb16-shard-a-r1`、`DMITPro2 inner bdfz:/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p4-mb16-shard-b-r1`、`DMITPro2 inner bdfz:new shard output roots`、`DMITPro2 inner bdfz:workspace/curriculum-ocr-reprocess@.service`、`curriculum-ocr-llama.service`、`DMITPro2 inner bdfz:curriculum-ocr-offload@a.service`、`DMITPro2 inner bdfz:curriculum-ocr-offload@b.service`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess@.service`、`DMITPro2 inner bdfz:curriculum-ocr-llama.service`、`DMITPro2 inner bdfz:new shard inputs manifests caches outputs`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess@a.service`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess@b.service`、`DMITPro2 inner bdfz:new shard outputs and logs`、`DMITPro2 inner bdfz:isolated shard outputs`、`DMITPro2 inner bdfz:shard a moe-2011-01 to moe-2022-03`、`DMITPro2 inner bdfz:shard b arts-labor`、`DMITPro2 inner bdfz curriculum-ocr-reprocess@a.service`、`curriculum-ocr-reprocess@b.service`、`run 20260716T1520Z-partial14-reprocess shard-b output`、`run 20260716T1520Z-partial14-reprocess`、`DMITPro2 partial14 isolated run`、`A and B OCR shards`

### 2026-07-16T15:20:21.258Z · start · root

- Scope：Execute the newly verified explicit whole-document remote reprocess workflow for the exact 14 locally partial OCR documents; preserve and snapshot all existing local OCR text witness and retry evidence until remote replacement is fully validated
- Resources：`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-production:14 selected documents`、`/Users/ylsuen/CF/curriculum-atlas/.cache/ocr-supervisor/page-retries.json`、`DMITPro2 inner bdfz isolated new run`
- Evidence：Safety implementation passes 226 tests; exact input 14 documents 6364 pages 1464 local completed 340796129 source bytes and one page retry; receiver supports hash-bound backup rollback and idempotence
- Rollback：Do not apply any replacement until the complete remote run and local dry-run pass; original local trees text and retry ledger remain intact and later move only into receipt backups
- Unresolved：Need create immutable planning snapshot transfer sources run remote OCR receive results and complete Vision/online publication gates

### 2026-07-16T15:20:21.287Z · change · root

- Scope：Create an atomic explicit reprocess manifest binding the current local partial-document tree text and retry snapshots for all 14 selected documents
- Resources：`/Users/ylsuen/CF/curriculum-atlas/.cache/remote-ocr-offload/20260716-partial14-reprocess-manifest.json`
- Evidence：Selection is explicit by 14 controlled queue IDs with no limit or glob; local watchdog held and no child; source hashes independently verified
- Rollback：Delete only the generated planning manifest if selection or snapshot validation fails; no OCR state changes
- Unresolved：Manifest counts and snapshot digests must match the 14-document execution contract before remote use

### 2026-07-16T15:20:53.412Z · verify · root

- Scope：Verified the generated 14-document reprocess planning snapshot before remote transfer or execution
- Resources：`/Users/ylsuen/CF/curriculum-atlas/.cache/remote-ocr-offload/20260716-partial14-reprocess-manifest.json`
- Evidence：Manifest SHA256 63368ce67b578412deeaf2620331e7c456c90bb688e4b2eda8706b011fb49db3; explicit mode; 14 documents; 6364 pages; 340796129 bytes; 1464 local completed; one local failed page and one retry entry; 14 unique snapshot digests; every document replace_existing_local_document and citation false
- Rollback：Manifest is additive and can be deleted without altering OCR state; source trees remain unchanged
- Unresolved：Need transfer exact source files and this manifest to the new isolated inner run then validate remote runtime and shard plan

### 2026-07-16T15:21:32.911Z · change · root

- Scope：Create a new isolated inner-workstation run root and stage only the verified reprocess manifest plus pinned runner code; reuse the already attested runtime and llama service read-only
- Resources：`DMITPro2 inner bdfz:/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess`
- Evidence：Manifest SHA256 63368ce67b578412deeaf2620331e7c456c90bb688e4b2eda8706b011fb49db3; new runner helper and OCR script pass local tests; previous r5/r6 runs remain immutable
- Rollback：Remove only the new isolated run root before service start if staged hashes differ; no old run service or output is modified
- Unresolved：Need remote hash readback source arrival runtime preflight and isolated service units

### 2026-07-16T15:50:05.462Z · change · root

- Scope：Generate and stage two exact page-balanced shard manifests for the isolated 14-document whole-document reprocess
- Resources：`curriculum-atlas/.cache/remote-ocr-offload/20260716-partial14-reprocess-shards`、`DMITPro2 inner bdfz:/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/manifests`
- Evidence：Deterministic exact partition is 3182 pages per shard; shard a 8 documents 126038707 bytes and shard b 6 documents 214757422 bytes; both pass the current runner validator and exact parent union checks
- Rollback：Remove only the two new shard manifests before service start if any remote hash or union check differs; parent manifest and OCR state remain unchanged
- Unresolved：Need remote hash readback, input validation per shard, isolated cache and unit preparation, then monitored start

### 2026-07-16T15:51:07.998Z · verify · root

- Scope：Verified the exact remote source set and both shard manifests before creating any OCR output root
- Resources：`DMITPro2 inner bdfz:/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/input/pdfs-verified`、`DMITPro2 inner bdfz:/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/manifests`
- Evidence：Parent validator passes 14 documents 6364 pages 340796129 bytes; shard hashes are 8b583fd5 and 305ff84e; shard validators pass exact 8 and 6 document sets with 3182 pages each
- Rollback：No OCR output exists yet; remove only new shard manifests if rejected
- Unresolved：Need prepare isolated caches and service, verify old workers inactive and llama attestation, then start without enabling

### 2026-07-16T15:51:08.022Z · change · root

- Scope：Create only the two new isolated OCR output roots and copy the already attested PaddleX runtime cache into each
- Resources：`DMITPro2 inner bdfz:/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p4-mb16-shard-a-r1`、`DMITPro2 inner bdfz:/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p4-mb16-shard-b-r1`
- Evidence：Old cache identity was independently verified as 17 files 171142109 bytes tree SHA256 737684d6 for each shard; copy is into new output roots only with mode 700 and no symlinks
- Rollback：Delete only the two new output roots before worker start; old runtime and old run outputs remain read-only
- Unresolved：Must re-fingerprint both copied caches and verify outputs contain no runner identity status or lock before start

### 2026-07-16T15:53:11.114Z · verify · root

- Scope：Verified isolated runtime caches and the new service template before installing any user unit
- Resources：`DMITPro2 inner bdfz:new shard output roots`、`DMITPro2 inner bdfz:workspace/curriculum-ocr-reprocess@.service`、`curriculum-ocr-llama.service`
- Evidence：Both caches are 17 files 171142109 bytes tree SHA256 737684d6 with no symlinks or run markers; systemd-analyze verify passes; unit SHA256 0d6562e5; llama is active running MainPID 1104 NRestarts 0 and health ok
- Rollback：No worker started; new output roots and staged unit can still be removed without touching old runs
- Unresolved：Old failed offload instances remain enabled and must be disabled before installing or starting the isolated workers

### 2026-07-16T15:53:11.138Z · change · root

- Scope：Disable only the two obsolete failed old offload instances and install the new isolated reprocess service template without enabling or starting it
- Resources：`DMITPro2 inner bdfz:curriculum-ocr-offload@a.service`、`DMITPro2 inner bdfz:curriculum-ocr-offload@b.service`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess@.service`
- Evidence：Both old instances are failed but enabled and could conflict after reboot; new template has isolated manifests inputs outputs logs caches and passes systemd verification
- Rollback：Remove the new template and daemon-reload; re-enable old instances only if intentionally returning to the previous settled run contract; no service restart is part of this step
- Unresolved：After install, recheck inactive disabled state and rerun preflight before explicit start only

### 2026-07-16T15:54:25.250Z · verify · root

- Scope：Completed final remote runtime and host preflight immediately before worker start
- Resources：`DMITPro2 inner bdfz:curriculum-ocr-llama.service`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess@.service`、`DMITPro2 inner bdfz:new shard inputs manifests caches outputs`
- Evidence：Pinned model and mmproj hashes exact; llama commit and command contract attested with parallel 4 health 200; 326 GiB free, 6.2 GiB available RAM, GPU 3358 MiB free idle at 44 C; old workers disabled and inactive/failed; new workers inactive and disabled
- Rollback：Before output acceptance stop only the two new instances and delete their isolated output roots; old runtime inputs and local snapshots remain
- Unresolved：Need explicit start without enable and immediate fail-fast monitoring of both shards

### 2026-07-16T15:54:25.274Z · change · root

- Scope：Start both exact 3182-page isolated reprocess workers without enabling them
- Resources：`DMITPro2 inner bdfz:curriculum-ocr-reprocess@a.service`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess@b.service`
- Evidence：All input runtime cache manifest unit and resource gates pass; total configured concurrency 8 matches the validated host and llama parallel contract
- Rollback：systemctl --user stop both new instances; retain logs status and partial isolated outputs for diagnosis; do not touch old run or local OCR trees
- Unresolved：Must prove both reach active processing with distinct locks no restarts and advancing page counters before considering the run healthy

### 2026-07-16T15:57:15.341Z · verify · root

- Scope：Verified both new OCR workers reached healthy active processing and produced their first complete micro-batches
- Resources：`DMITPro2 inner bdfz:curriculum-ocr-reprocess@a.service`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess@b.service`、`DMITPro2 inner bdfz:new shard outputs and logs`
- Evidence：Both services active running disabled with NRestarts 0 and distinct runner child PIDs; shard a moe-2011-01 pages 1-16 and shard b arts-labor pages 1-16 completed with zero failed pages; llama has 4 processing plus 4 deferred requests, GPU 77 percent and host remains within memory disk thermal limits
- Rollback：Stop only both new instances and retain isolated partial output logs status and input for diagnosis; no local OCR replacement has occurred
- Unresolved：Run is long-lived at the safe llama parallel-4 ceiling; continue automatic supervision and fail-fast on restart page failure quarantine stalled status memory or thermal drift

### 2026-07-16T16:06:12.507Z · verify · root

- Scope：Confirmed sustained multi-batch progress and healthy transition toward the next document under the pinned parallel-4 runtime
- Resources：`DMITPro2 inner bdfz:curriculum-ocr-reprocess@a.service`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess@b.service`、`DMITPro2 inner bdfz:isolated shard outputs`
- Evidence：At 2026-07-16T16:05Z shard a completed 80 of first 83 pages and shard b completed 64 of first 491 pages; both have zero failed pages, ActiveState active, NRestarts 0, llama health ok; GPU 90 percent 81 C with 2574 of 6144 MiB used and 326 GiB disk free
- Rollback：Stop only both new instances and retain isolated outputs logs and state for diagnosis; no local OCR tree has been replaced
- Unresolved：Continue fail-fast monitoring through first-document rollover; install the reviewed read-only monitor before enabling reboot resume

### 2026-07-16T16:08:11.639Z · verify · root

- Scope：Verified the first complete-document rollover without worker restart or loss of shard continuity
- Resources：`DMITPro2 inner bdfz:shard a moe-2011-01 to moe-2022-03`、`DMITPro2 inner bdfz:shard b arts-labor`
- Evidence：moe-2011-01 reached 83 of 83 pages with zero failures; shard a automatically created moe-2022-03 state and launched its OCR child while the parent service remained active with NRestarts 0; shard b independently reached 80 pages with zero failures
- Rollback：Stop only both new service instances and retain the isolated per-document state and logs; restart resumes from completed page state
- Unresolved：CPU package reaches the mid-90s C and thermal counters advance under dual preprocessing; read-only monitor is being extended with CPU warning and critical thresholds before reboot enablement

### 2026-07-16T16:32:14.339Z · verify · root

- Scope：Respond to remote monitor memory critical sample without interrupting healthy work
- Resources：`DMITPro2 inner bdfz curriculum-ocr-reprocess@a.service`、`curriculum-ocr-reprocess@b.service`、`curriculum-ocr-llama.service`
- Evidence：Monitor sample at 16:29Z reported MemAvailable 0.583 GiB; immediate read-only recheck recovered to 1.3 GiB with 19 GiB swap total, both workers and llama active, NRestarts 0, no OCR failures, GPU 84 C, two OCR children about 1.6 and 1.3 GiB RSS and llama about 10.7 GiB RSS
- Rollback：No mutation made; if low memory persists for a consecutive monitor sample or any OOM or restart appears, stop only one reprocess shard and resume it from state after memory stabilizes
- Unresolved：Memory headroom is narrow and swap activity is significant; continue two-minute fail-fast observation

### 2026-07-16T16:55:23.811Z · verify · codex-root

- Scope：Kept both OCR shards active after a single low-memory sample because the next sample and immediate diagnostics recovered above threshold
- Resources：`DMITPro2 inner bdfz:curriculum-ocr-reprocess@a.service`、`curriculum-ocr-reprocess@b.service`、`curriculum-ocr-llama.service`
- Evidence：16:48 monitor MemAvailable 0.85 GiB; immediate free reported 1.60 GiB available, 13.12 GiB swap free, no kernel OOM, no user-unit warnings, both workers and llama active with NRestarts 0; 16:52 monitor recovered to 1.56 GiB and 736/6364 pages total with zero failures
- Rollback：No mutation made; if two consecutive monitor samples fall below 1 GiB or any OOM/restart appears, stop only one reprocess shard and resume from its persisted state after stabilization
- Unresolved：Memory and CPU thermal headroom remain narrow; continue two-minute observation

### 2026-07-16T17:55:29.573Z · change · codex-root

- Scope：Pause only OCR shard B after the predeclared two-consecutive-samples-below-1-GiB memory safety gate was met; keep shard A and llama active and preserve all B progress for resume
- Resources：`DMITPro2 inner bdfz:curriculum-ocr-reprocess@b.service`、`run 20260716T1520Z-partial14-reprocess shard-b output`
- Evidence：Monitor samples 17:29:02Z=0.793 GiB and 17:31:02Z=0.633 GiB were consecutive below threshold; 17:43:26Z again 0.701 GiB, swap about 6.3 GiB, CPU 97C; B had 619 completed pages, zero failures, zero restarts, persisted hash-bound state
- Rollback：Resume only curriculum-ocr-reprocess@b.service after memory headroom is stable and verify exact persisted progress, llama health, zero restarts and advancing pages; shard A and all B output remain untouched
- Unresolved：Must verify B becomes inactive without failure, A and llama remain healthy, and memory pressure recovers before considering resume

### 2026-07-16T18:10:20.975Z · verify · codex-root

- Scope：Verified the memory-gate B pause preserved resumable OCR state while A and llama continued
- Resources：`DMITPro2 inner bdfz curriculum-ocr-reprocess@a.service`、`curriculum-ocr-reprocess@b.service`、`curriculum-ocr-llama.service`、`run 20260716T1520Z-partial14-reprocess`
- Evidence：B is inactive dead disabled with Result success and NRestarts 0 at 683 completed pages; A is active running with NRestarts 0 at 750 completed pages; llama health is HTTP 200; total 1433 of 6364 pages, zero failed; available memory recovered to 2.099 GiB and B run-status sidecar remains hash-valid
- Rollback：Resume only B with systemctl --user enable --now curriculum-ocr-reprocess@b.service after safety review; its 683-page state remains intact
- Unresolved：A continues alone; CPU remains near warning at 96C and B must not resume until memory and thermal headroom are sustained

### 2026-07-17T02:04:06.511Z · closeout · codex-root

- Scope：Close predecessor partial14 execution task after guarded A B service ownership transferred to the resume task and now to curriculum-atlas-full-release-20260716
- Resources：`DMITPro2 partial14 isolated run`、`A and B OCR shards`
- Evidence：The last verified 2026-07-17T01:26Z snapshot recorded 2153 of 6364 pages with zero failed or quarantined pages and zero service restarts
- Rollback：Preserve all append-only OCR state; existing memory and thermal guards own any exact worker stop
- Unresolved：Remote replacement remains staging-only and non-citable until whole-document witness audit online same-version verification and adjudication complete

</details>

<details><summary><code>curriculum-vision-lazy-log-open-20260716</code> · 4 events · 2026-07-16T15:26:03.954Z → 2026-07-16T15:27:41.477Z</summary>

Agents：`/root/evidence_backfill_runner`
Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/ocr-supervisor.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-supervisor-evidence-drain.test.mjs`

### 2026-07-16T15:26:03.954Z · start · /root/evidence_backfill_runner

- Scope：Ensure Apple Vision child lifetime has no real log FileHandle by lazily opening the log only after child exit and both pipes end; preserve regular-fd child behavior
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/ocr-supervisor.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-supervisor-evidence-drain.test.mjs`
- Evidence：Parent supplied a third minimal reproduction: merely retaining a real fs FileHandle during Swift Vision execution triggers Foundation GenericObjCError even without writes; a fake handle or no open file succeeds
- Rollback：Revert only lazy log-open helper and focused tests; do not run a Vision canary or any long OCR task
- Unresolved：Need prove pipe child starts and exits before open is called, then exactly one open write close sequence; regular-fd mode must still open before spawn

### 2026-07-16T15:27:41.431Z · change · /root/evidence_backfill_runner

- Scope：Made Apple Vision log creation fully lazy so no real fs FileHandle exists during Swift child execution
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/ocr-supervisor.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-supervisor-evidence-drain.test.mjs`
- Evidence：pipeOutput now spawns with null log handle and pipe stdio; bounded buffers capture only memory; after child exit and both pipe streams end, flush calls open(logPath,a), performs one write, and closes; regular mode still opens before spawn and binds the fd
- Rollback：Revert only lazy-open helper and focused assertions; no OCR artifacts or retry state were changed
- Unresolved：Need regression verification only; real one-page canary remains prohibited until parent runs it

### 2026-07-16T15:27:41.454Z · verify · /root/evidence_backfill_runner

- Scope：Verified no real log FileHandle exists through the full Apple Vision child lifetime and regular-fd logging remains unchanged
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/ocr-supervisor.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-supervisor-evidence-drain.test.mjs`
- Evidence：Focused supervisor suite passes 34 of 34; full npm test passes 227 of 227; TypeScript syntax and diff checks pass; injected open spy remains empty at spawn while running and after exit before flush, then records exactly open:a, one write, close; pipe log path remains ENOENT until flush
- Rollback：No runtime rollback is needed; tests use temporary files and source changes are file-surgical
- Unresolved：No Vision Paddle llama or long task was launched; parent must validate with the real one-page canary before resuming evidence drain

### 2026-07-16T15:27:41.477Z · closeout · /root/evidence_backfill_runner

- Scope：Hand off the third-layer Apple Vision lazy-log fix for parent-owned canary verification
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/ocr-supervisor.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-supervisor-evidence-drain.test.mjs`
- Evidence：The implementation now satisfies the minimal reproduction boundary: Swift sees no task log FileHandle at any time before it and both output streams have fully ended
- Rollback：Revert the scoped helper and tests only; existing corpus witnesses audits and retry records are untouched
- Unresolved：Actual evidence backfill remains paused pending a successful one-page canary

</details>

<details><summary><code>curriculum-r6-corpus-quality-audit-20260716</code> · 2 events · 2026-07-16T15:39:23.463Z → 2026-07-17T02:04:06.280Z</summary>

Agents：`root`、`codex-root`
Resources：`curriculum-atlas/.cache/ocr-production`、`curriculum-atlas/.cache/ocr-receipts/2026-07-16T14-58-25-768Z-3050f22e7bda-2d3f55d6/receipt.json`、`curriculum-atlas/.cache/sources`、`r6 OCR corpus audit evidence`

### 2026-07-16T15:39:23.463Z · verify · root

- Scope：Independent read-only audit of all 72 imported documents and 5483 pages
- Resources：`curriculum-atlas/.cache/ocr-production`、`curriculum-atlas/.cache/ocr-receipts/2026-07-16T14-58-25-768Z-3050f22e7bda-2d3f55d6/receipt.json`、`curriculum-atlas/.cache/sources`
- Evidence：Structural ingest passes 72 of 72 documents and 5483 of 5483 pages with exact hashes; semantic publication is blocked by 11 missed or incomplete foreign-language pages, Russian glossary script hallucination ranges, Japanese row-shift errors on pages 54 60 61, and one exact duplicate source pair; all imported pages remain non-citable
- Rollback：Read-only audit made no production source cache or Cloudflare changes; temporary renders are confined to /private/tmp/curriculum-r6-audit
- Unresolved：Must add fail-closed semantic gates, rerun affected foreign-language ranges with language-specific OCR, row-align glossaries, deduplicate the identical source pair, then repeat image OCR online-version triangulation before publication

### 2026-07-17T02:04:06.280Z · closeout · codex-root

- Scope：Close independent read-only r6 corpus audit after all findings were transferred into explicit fail-closed semantic and source-verification controls
- Resources：`r6 OCR corpus audit evidence`
- Evidence：Every finding is represented by a semantic quarantine source mapping or publication gate owned by the full release
- Rollback：No mutation occurred; preserve the audit evidence
- Unresolved：Affected pages remain non-citable until exact gates pass

</details>

<details><summary><code>curriculum-r6-semantic-quarantine-gate-20260716</code> · 4 events · 2026-07-16T15:44:45.067Z → 2026-07-16T16:01:01.732Z</summary>

Agents：`/root/semantic_quarantine_gate`
Resources：`data/page-publication-manifest.json`、`data/page-publication-manifest.schema.json`、`scripts/page-publication-gate.mjs`、`scripts/build-corpus.mjs`、`scripts/build-concept-evolution.mjs`、`tests/page-publication-gate.test.mjs`、`tests/concept-publication-gate.test.mjs`、`data/semantic-publication-policy.json`、`data/semantic-publication-policy.schema.json`、`scripts/semantic-publication-gate.mjs`、`scripts/concept-page-publication.mjs`、`tests/semantic-publication-gate.test.mjs`、`data/corpus-chunks/manifest.json`、`public/data/concept-evolution.json`、`public/data/concept-evolution-academic.json`、`data/concept-evolution-quality.json`、`scripts/validate-concept-evolution.mjs`

### 2026-07-16T15:44:45.067Z · start · /root/semantic_quarantine_gate

- Scope：Encode the independent r6 corpus audit findings as a fail-closed page and document publication policy; exclude known OCR defects and exact duplicate aliases from corpus and concept derivation without touching OCR caches remote jobs deployment or production data
- Resources：`data/page-publication-manifest.json`、`data/page-publication-manifest.schema.json`、`scripts/page-publication-gate.mjs`、`scripts/build-corpus.mjs`、`scripts/build-concept-evolution.mjs`、`tests/page-publication-gate.test.mjs`、`tests/concept-publication-gate.test.mjs`
- Evidence：Git status and recent action ownership inspected; task scope is source data and focused tests only; existing dirty work is preserved and no active task claims the semantic quarantine policy files
- Rollback：Revert only task-owned source data and test hunks; generated OCR caches and all remote state remain untouched
- Unresolved：Need identify exact audited document and page ranges from local production text and audit artifacts before encoding the gate

### 2026-07-16T15:57:26.354Z · change · /root/semantic_quarantine_gate

- Scope：Added an auditable semantic publication policy with exact-source alias deduplication, page-level quarantine ranges, and extensible foreign-language OCR quality profiles; wired corpus and concept builders to exclude blocked pages and aliases before derivation
- Resources：`data/semantic-publication-policy.json`、`data/semantic-publication-policy.schema.json`、`scripts/semantic-publication-gate.mjs`、`scripts/build-corpus.mjs`、`scripts/concept-page-publication.mjs`、`scripts/build-concept-evolution.mjs`、`tests/semantic-publication-gate.test.mjs`
- Evidence：Policy validates against catalog with 17 controls, 175 unique blocked pages, 165 Russian glossary pages, 11 exact missed pages, three Japanese row controls, one exact-source alias; focused page/concept/semantic tests pass 21 of 21
- Rollback：Restore three pre-existing builder files from /private/tmp/curriculum-semantic-gate-backup-20260716 and remove only the new semantic policy gate schema and focused test
- Unresolved：Need rebuild corpus and concept outputs, validate the generated graph, then run the full suite

### 2026-07-16T16:00:47.301Z · verify · /root/semantic_quarantine_gate

- Scope：Verified the semantic publication gate at manifest, unit, corpus-build, concept-build, validator, TypeScript, static-build, and full-regression levels without OCR or remote mutation
- Resources：`data/semantic-publication-policy.json`、`scripts/semantic-publication-gate.mjs`、`data/corpus-chunks/manifest.json`、`public/data/concept-evolution.json`、`public/data/concept-evolution-academic.json`、`data/concept-evolution-quality.json`
- Evidence：Policy binds 17 controls and 175 unique pages: 11 exact missed or incomplete pages, four Russian glossary ranges totaling 165 pages, three Japanese row-alignment pages, with four missed pages overlapping the Russian ranges; exact alias ictr-6c6df9d121ac maps to canonical moe-2022-17. Corpus build produced 16456 paragraphs, accepted OCR documents 0, excluded alias documents 1. Concept build and validator pass with 195 canonical catalog records plus one alias, 85 canonical OCR queue documents and 11779 pages; canonical work and edition carry the alias and no alias work or edition exists. Focused tests 21 of 21 and full tests 241 of 241 pass; tsc, static build, syntax, and diff checks pass
- Rollback：Restore pre-existing builders from /private/tmp/curriculum-semantic-gate-backup-20260716, revert task-owned validator and two fail-closed zero-OCR test adjustments, remove new policy gate schema and test, then rebuild corpus and concept artifacts
- Unresolved：Affected pages remain blocked until language-specific OCR, source-image comparison, glossary row alignment where applicable, same-edition online text check, and version-match attestation are complete; all current OCR page publication entries remain absent and citation false

### 2026-07-16T16:01:01.732Z · closeout · /root/semantic_quarantine_gate

- Scope：Hand off the fail-closed r6 semantic quarantine and exact-source deduplication gate after regenerated local artifacts and complete validation
- Resources：`data/semantic-publication-policy.json`、`data/semantic-publication-policy.schema.json`、`scripts/semantic-publication-gate.mjs`、`scripts/build-corpus.mjs`、`scripts/concept-page-publication.mjs`、`scripts/build-concept-evolution.mjs`、`scripts/validate-concept-evolution.mjs`、`tests/semantic-publication-gate.test.mjs`、`public/data/concept-evolution.json`、`public/data/concept-evolution-academic.json`、`data/concept-evolution-quality.json`
- Evidence：Policy SHA256 ea44cc2f5a670f5b3557ef5decf490cf90585e82b635bf9b3c857e61b5a15239; semantic gate SHA256 98600b34241797f2cbf1a22af00ab91ad296ca1d2081b731bbba6c7370b54a55; academic build revision 4f90b2db4a4c46e5bf6bf921c9ffb7f8ac9c514b85f21a58bc8331cb1d4b6b33 and quality passed true; full tests 241 of 241
- Rollback：Use /private/tmp/curriculum-semantic-gate-backup-20260716 for the three pre-existing builder files and surgically revert only the task-owned semantic policy validator tests and generated artifacts; no OCR cache remote process Cloudflare resource or deployment requires rollback
- Unresolved：No controlled foreign-language page is publication-ready; the explicit resolution requirements remain language-specific OCR, original-image comparison, row alignment for tables, same-edition online corroboration, and version-match verification

</details>

<details><summary><code>curriculum-vision-launcher-isolation-20260716</code> · 4 events · 2026-07-16T15:44:47.780Z → 2026-07-16T15:49:51.345Z</summary>

Agents：`/root/evidence_backfill_runner`
Resources：`curriculum-atlas/scripts/vision-ocr-launcher.mjs`、`curriculum-atlas/scripts/ocr-supervisor.mjs`、`curriculum-atlas/scripts/lib/ocr-supervisor-state.mjs`、`curriculum-atlas/tests/vision-ocr-launcher.test.mjs`、`curriculum-atlas/tests/ocr-supervisor-evidence-drain.test.mjs`、`curriculum-atlas/tests/ocr-supervisor-faults.test.mjs`、`curriculum-atlas/package.json`

### 2026-07-16T15:44:47.780Z · start · /root/evidence_backfill_runner

- Scope：Implement and verify a strict fresh-Node Vision OCR launcher isolation layer; changes were already underway from the parent follow-up before this row was appended
- Resources：`curriculum-atlas/scripts/vision-ocr-launcher.mjs`、`curriculum-atlas/scripts/ocr-supervisor.mjs`、`curriculum-atlas/scripts/lib/ocr-supervisor-state.mjs`、`curriculum-atlas/tests/vision-ocr-launcher.test.mjs`
- Evidence：Ownership is limited to the launcher, Vision supervisor call sites, provenance validation, and launcher tests; current git status was inspected and unrelated dirty work is preserved
- Rollback：Revert only the scoped launcher integration and tests; Paddle logging and unrelated OCR work remain untouched
- Unresolved：Focused and full validation still pending; real OCR canary, retries, cache, and remote resources are explicitly excluded

### 2026-07-16T15:46:18.965Z · change · /root/evidence_backfill_runner

- Scope：Added a strict fresh-Node Apple Vision launcher and routed both supervisor batch and page-retry Vision calls through it
- Resources：`curriculum-atlas/scripts/vision-ocr-launcher.mjs`、`curriculum-atlas/scripts/ocr-supervisor.mjs`、`curriculum-atlas/scripts/lib/ocr-supervisor-state.mjs`、`curriculum-atlas/tests/vision-ocr-launcher.test.mjs`
- Evidence：Launcher spawns only /usr/bin/swift with the pinned Vision script, buffers stdout and stderr in memory with a combined 8 MiB ceiling, forwards only after child close, propagates TERM and INT with bounded KILL escalation, and provenance records launcher path and SHA while absent launcher fields remain backward compatible
- Rollback：Remove the launcher file and revert only the two Vision invocation call sites plus launcher provenance validation and tests; ordinary Paddle file-descriptor logging remains unchanged
- Unresolved：Independent code review is still pending; no real Vision OCR canary, retry mutation, cache write, or remote action was performed

### 2026-07-16T15:48:01.247Z · verify · /root/evidence_backfill_runner

- Scope：Verified the launcher isolation layer without executing real OCR
- Resources：`curriculum-atlas/tests/vision-ocr-launcher.test.mjs`、`curriculum-atlas/tests/ocr-supervisor-evidence-drain.test.mjs`、`curriculum-atlas/tests/ocr-supervisor-faults.test.mjs`、`curriculum-atlas/package.json`
- Evidence：Focused launcher tests 6 of 6 pass; combined supervisor suite 40 of 40 pass; full npm test 233 of 233 pass; npm run check passes; both Node syntax checks and git diff check pass; probe-version succeeds; source scan finds /usr/bin/swift spawning only inside the launcher; launcher SHA256 is 5921b08c2abac5974de5b20087523284e2eac01090d472d6b0d4008d3d253d0b
- Rollback：No production rollback is required because validation used only synthetic Swift probes and read-only checks; scoped source changes can be reverted independently
- Unresolved：Independent code review remains pending; no real OCR canary, retry clearing, cache mutation, or remote deployment was run

### 2026-07-16T15:49:51.345Z · closeout · /root/evidence_backfill_runner

- Scope：Hand off the verified fresh-Node Vision launcher isolation layer to the parent task
- Resources：`curriculum-atlas/scripts/vision-ocr-launcher.mjs`、`curriculum-atlas/scripts/ocr-supervisor.mjs`、`curriculum-atlas/scripts/lib/ocr-supervisor-state.mjs`、`curriculum-atlas/tests/vision-ocr-launcher.test.mjs`
- Evidence：Implementation and all requested automated checks pass: actual launcher-to-Swift parent PID, delayed forwarding, fail-closed overflow and TERM cleanup, two supervisor call sites, launcher provenance with old-witness compatibility, 233 of 233 full tests, and TypeScript plus syntax checks
- Rollback：Revert only the launcher file, two Vision routing calls, nested launcher provenance validation, and launcher tests; no live OCR or remote state needs rollback
- Unresolved：Parent still owns any later supervised real Vision canary and operational rollout; this task intentionally did not clear retries, modify OCR cache, run real OCR, or touch remote resources

</details>

<details><summary><code>curriculum-partial14-remote-monitor-source-20260716</code> · 4 events · 2026-07-16T15:59:30.417Z → 2026-07-16T16:11:04.206Z</summary>

Agents：`/root/remote_ocr_monitor`
Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/monitor-remote-ocr-reprocess.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-reprocess-monitor.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.service`、`/Users/ylsuen/CF/curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.timer`

### 2026-07-16T15:59:30.417Z · start · /root/remote_ocr_monitor

- Scope：Implement source-only read-only monitoring for the isolated partial14 DMITPro2 OCR run; own one new monitor script, focused tests, and task-scoped user systemd service/timer templates; exclude SSH, remote deployment, timer activation, OCR data mutation, restart logic, Cloudflare, D1, R2, frontend, corpus, and reports
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/monitor-remote-ocr-reprocess.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-reprocess-monitor.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.service`、`/Users/ylsuen/CF/curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.timer`
- Evidence：Read required matrix architecture backend VPS and project OCR operations runbooks; inspected dirty tree and active action ownership; all target files are new and disjoint
- Rollback：Remove only the four new task-scoped source artifacts if rejected; no remote or live state is authorized
- Unresolved：Need implement atomic snapshot and privacy-safe event log, fail-closed health classification, tests, and inert deployment commands

### 2026-07-16T16:10:23.659Z · change · /root/remote_ocr_monitor

- Scope：Added a task-scoped read-only monitor, privacy-safe state/event outputs, and inert two-minute user systemd templates for the exact isolated partial14 OCR run; no SSH deployment service activation or OCR mutation
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/monitor-remote-ocr-reprocess.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-reprocess-monitor.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.service`、`/Users/ylsuen/CF/curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.timer`
- Evidence：Monitor verifies both run-status SHA sidecars and documents state trees, systemd ActiveState SubState NRestarts ExecMainStatus MainPID, loopback llama health, disk memory GPU and mandatory sensors CPU package core ACPI thermal; records optional sysfs throttle counters and GPU active throttle reason; 97 C warns nonzero, 99 C blocks
- Rollback：Remove only the four new source artifacts; no live service, timer, OCR output, or remote host state changed
- Unresolved：Remote install must create the monitor directory, copy the exact script and units, run systemd-analyze verify and a manual oneshot canary before enabling the timer

### 2026-07-16T16:10:53.506Z · verify · /root/remote_ocr_monitor

- Scope：Verified the complete source-only remote OCR monitor and inert systemd templates locally; no SSH remote install daemon-reload service start or timer enable occurred
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/monitor-remote-ocr-reprocess.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-reprocess-monitor.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.service`、`/Users/ylsuen/CF/curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.timer`
- Evidence：Focused monitor tests 10 of 10; full repository tests 252 of 252; TypeScript and Node syntax pass; diff whitespace pass; tests cover healthy and completed zero, stall 11, thermal warning 10, all hard failures 12, unavailable sensors fail-closed, atomic latest JSON, privacy-safe JSONL, exact paths and no automatic restart stop delete behavior
- Rollback：No external rollback applies; remove only the four new untracked files if the source change is rejected
- Unresolved：Local macOS lacks systemd-analyze; remote systemd-analyze --user verify and manual oneshot canary are mandatory before enabling the two-minute timer

### 2026-07-16T16:11:04.206Z · closeout · /root/remote_ocr_monitor

- Scope：Hand off the complete source-only monitoring package for parent-controlled remote verification and deployment; preserve all existing OCR jobs outputs services and dirty work
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/monitor-remote-ocr-reprocess.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/remote-ocr-reprocess-monitor.test.mjs`、`/Users/ylsuen/CF/curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.service`、`/Users/ylsuen/CF/curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.timer`
- Evidence：Final SHA256 script 74bc4a15, test 59ae1684, service a6f836dc, timer 743ba180; all 252 tests pass and the source contains no OCR control or destructive command
- Rollback：Disable only curriculum-ocr-reprocess-monitor.timer, stop only the oneshot if active, and remove only the copied monitor script unit templates and monitor outputs if parent later rolls it back; never touch worker outputs or quarantine state
- Unresolved：Parent owns remote copy checksum readback systemd verify manual canary and optional timer activation; CPU live peak 96 C remains below warning 97 C but close enough to require monitoring

</details>

<details><summary><code>curriculum-vision-launcher-discrepancy-20260716</code> · 4 events · 2026-07-16T16:01:19.090Z → 2026-07-16T16:11:00.681Z</summary>

Agents：`/root/evidence_backfill_runner`
Resources：`curriculum-atlas/scripts/vision-ocr-launcher.mjs`、`curriculum-atlas/tests/vision-ocr-launcher.test.mjs`、`/private/tmp/curriculum-vision-launcher-diagnose`、`ictr-043d90816a8b page-001`、`/private/tmp/curriculum-vision-launcher-diagnose-20260716`

### 2026-07-16T16:01:19.090Z · start · /root/evidence_backfill_runner

- Scope：Diagnose the real page-one discrepancy between a successful fresh direct Node helper and the current reusable Vision launcher; compare signal listener, inline spawn, and imported runVisionLauncher process contracts, then patch only if evidence is exact
- Resources：`curriculum-atlas/scripts/vision-ocr-launcher.mjs`、`curriculum-atlas/tests/vision-ocr-launcher.test.mjs`、`/private/tmp/curriculum-vision-launcher-diagnose`
- Evidence：Existing dirty tree and active ownership inspected; actual probe is restricted to one existing rendered page and isolated temporary output directories; process environment comparison will record only key names and a deterministic hash, never values
- Rollback：Remove temporary diagnostic outputs and revert only launcher/test changes; no corpus, semantic gate, retries, OCR cache, remote workers, or deployment state will be modified
- Unresolved：Need reproduce all three launch shapes, identify the exact differentiator, repair the double-five-second escalation race, and prove one real page returns no error with nonzero lines

### 2026-07-16T16:10:36.837Z · change · /root/evidence_backfill_runner

- Scope：Shortened the launcher-owned termination grace to 1500 ms and retained both signal handlers until child close so the outer supervisor cannot kill the launcher before it kills and reaps Swift
- Resources：`curriculum-atlas/scripts/vision-ocr-launcher.mjs`、`curriculum-atlas/tests/vision-ocr-launcher.test.mjs`
- Evidence：New regression uses an actual uncooperative child with IPC readiness, sends two TERM signals, requires exit 143, proves child ESRCH, and completes below the supervisor 5000 ms grace
- Rollback：Revert only the terminate-grace constant, persistent signal listener lines, and the uncooperative-child test; OCR data and operational state were not changed
- Unresolved：Launcher provenance downgrade compatibility and the older fixed-delay Swift signal test remain non-blocking follow-ups; neither affects the established sandbox root cause

### 2026-07-16T16:10:47.529Z · verify · /root/evidence_backfill_runner

- Scope：Proved the real page launcher discrepancy is the Codex macOS sandbox blocking Apple Vision XPC, then validated the patched launcher outside that sandbox
- Resources：`ictr-043d90816a8b page-001`、`/private/tmp/curriculum-vision-launcher-diagnose-20260716`、`curriculum-atlas/scripts/vision-ocr-launcher.mjs`、`curriculum-atlas/tests/vision-ocr-launcher.test.mjs`
- Evidence：Under one identical unsandboxed parent, direct helper with signal listeners, inline direct spawn, and imported runVisionLauncher all used identical cwd and environment fingerprints and returned error null with 5 lines; sandboxed file launcher failed, sandboxed with the indicator variable removed still failed, and the exact file launcher unsandboxed succeeded with error null and 5 lines. Focused 41 of 41 and full 252 of 252 tests pass; TypeScript syntax and diff checks pass
- Rollback：Only temporary isolated outputs and source-level launcher race changes exist; no cache retry semantic gate remote worker or deployment rollback is required
- Unresolved：Any real supervisor Vision run launched by Codex must use an approved unsandboxed execution path or an external service; ordinary default sandbox execution will deterministically return Foundation GenericObjCError

### 2026-07-16T16:11:00.681Z · closeout · /root/evidence_backfill_runner

- Scope：Hand off the exact Apple Vision launcher root cause and verified termination-race repair to the parent
- Resources：`curriculum-atlas/scripts/vision-ocr-launcher.mjs`、`curriculum-atlas/tests/vision-ocr-launcher.test.mjs`、`/private/tmp/curriculum-vision-launcher-diagnose-20260716`
- Evidence：Root cause is active Codex seatbelt restriction on Apple Vision XPC, not spawn args cwd environment signal listeners launcher imports buffering or startup timing; final launcher SHA256 6d046470ccf27ee902db0da1c5299bb9bfac20c438aaca0182c86b2909e94b26 and isolated real page sidecar has error null lineCount 5
- Rollback：Revert only the scoped 1500 ms grace and retained-handler test changes if rejected; diagnostic outputs are isolated under the task temporary directory; no live OCR or remote state was mutated
- Unresolved：Parent should run any real supervisor canary and later drain only through an unsandboxed approved command or external service. Provenance schema downgrade and the older fixed-delay signal test are report-only follow-ups

</details>

<details><summary><code>curriculum-r6-foreign-language-online-source-mapping-20260716</code> · 4 events · 2026-07-16T16:03:12.257Z → 2026-07-16T18:00:04.333Z</summary>

Agents：`/root/semantic_quarantine_gate`
Resources：`data/catalog.json`、`data/ingest-manifest.json`、`data/document-sources.json`、`data/semantic-publication-policy.json`、`official MOE and ICTR source URLs`、`academic source discovery`、`data/online-verification/r6-foreign-language-source-map.json`、`data/online-verification/r6-foreign-language-source-map.schema.json`、`docs/r6-foreign-language-online-source-map.md`、`tests/r6-foreign-language-source-map.test.mjs`

### 2026-07-16T16:03:12.257Z · start · /root/semantic_quarantine_gate

- Scope：Build a read-only same-edition online verification source map for only five quarantined Russian and Japanese curriculum-standard documents; distinguish exact artifact, same edition, different edition, and unconfirmed sources without opening any publication gate
- Resources：`data/catalog.json`、`data/ingest-manifest.json`、`data/document-sources.json`、`data/semantic-publication-policy.json`、`official MOE and ICTR source URLs`、`academic source discovery`
- Evidence：The five document identities, official source URLs, source SHA-256 digests, page counts, titles, subjects, and edition labels were extracted exactly from checked-in manifests; current dirty work and active ownership were inspected and the task excludes OCR corpus concepts frontend remote and deployment state
- Rollback：Remove only any task-created evidence mapping schema report and focused test; all source PDFs caches publication gates and generated product artifacts remain unchanged
- Unresolved：Need verify each online candidate at title edition publisher page-range and content-availability levels; approximate or revised editions must remain non-matching

### 2026-07-16T17:55:58.926Z · change · /root/semantic_quarantine_gate

- Scope：Added a task-scoped fail-closed same-edition online source mapping for exactly five quarantined Russian and Japanese curriculum standards
- Resources：`data/online-verification/r6-foreign-language-source-map.json`、`data/online-verification/r6-foreign-language-source-map.schema.json`、`docs/r6-foreign-language-online-source-map.md`、`tests/r6-foreign-language-source-map.test.mjs`
- Evidence：Recorded live official PDF hashes and page counts, the 2011 MOE to ICTR two-blank-page mapping, exact-artifact versus same-edition distinctions, and the Japan Foundation same-edition translated lexical witness; all document conclusions remain publication_gate_changed false and can_unlock false
- Rollback：Remove only the four task-created mapping schema report and focused test files; no OCR corpus concept frontend gate remote or deploy state was changed
- Unresolved：Russian documents still lack proven independent same-edition glossary text; the 2011 secondary artifact has undocumented digitization lineage; the Japanese translation loses physical pagination table layout and some accent symbols

### 2026-07-16T17:58:02.433Z · verify · /root/semantic_quarantine_gate

- Scope：Validated the task-scoped foreign-language online source map without opening any publication or citation gate
- Resources：`data/online-verification/r6-foreign-language-source-map.json`、`data/online-verification/r6-foreign-language-source-map.schema.json`、`docs/r6-foreign-language-online-source-map.md`、`tests/r6-foreign-language-source-map.test.mjs`
- Evidence：jq parsing passed; focused Node tests passed 6 of 6; full repository tests passed 324 of 324; TypeScript no-emit check passed; site build passed; task-file diff check passed; mapping SHA-256 de71f2e683dcc9052ca8ea8029f4c4004a190a698bd3121ac2d2c6a2123ef4c0
- Rollback：Delete only the four task-created files if this evidence layer must be reverted; generated dist can be rebuilt from unchanged public sources
- Unresolved：Online evidence improves adjudication inputs but is insufficient by itself to release any controlled page

### 2026-07-16T18:00:04.333Z · closeout · /root/semantic_quarantine_gate

- Scope：Closed the five-document same-edition online verification mapping task with all semantic publication controls unchanged
- Resources：`data/online-verification/r6-foreign-language-source-map.json`、`data/online-verification/r6-foreign-language-source-map.schema.json`、`docs/r6-foreign-language-online-source-map.md`、`tests/r6-foreign-language-source-map.test.mjs`
- Evidence：Five exact primary artifacts were live reverified; 2022 duplicate official URLs were proven byte-identical; 2011 same-edition secondary pagination was mapped; Japan Foundation translation anchors were documented; publication_gate_changed remains false and can_unlock remains false
- Rollback：Remove only the task-scoped evidence files and rerun the focused or full test suite; no production rollback is required because no remote or product state changed
- Unresolved：Future release still requires language-specific OCR, source-image comparison, row alignment verification, version match verification and complete page-level adjudication under the existing semantic policy

</details>

<details><summary><code>curriculum-partial14-remote-monitor-deploy-20260716</code> · 4 events · 2026-07-16T16:12:09.120Z → 2026-07-16T16:17:22.523Z</summary>

Agents：`root`
Resources：`curriculum-atlas/scripts/monitor-remote-ocr-reprocess.mjs`、`curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.service`、`curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.timer`、`DMITPro2 inner bdfz:user systemd monitor units`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess-monitor.service`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess-monitor.timer`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess@a.service`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess@b.service`、`DMITPro2 inner bdfz:monitor/latest.json`、`DMITPro2 inner bdfz:monitor/events.jsonl`、`DMITPro2 inner bdfz:monitor timer and reprocess workers`

### 2026-07-16T16:12:09.120Z · start · root

- Scope：Deploy and verify only the reviewed read-only monitor for the isolated partial14 OCR run; preserve both OCR workers, llama, outputs, manifests, caches, and retry state
- Resources：`curriculum-atlas/scripts/monitor-remote-ocr-reprocess.mjs`、`curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.service`、`curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.timer`、`DMITPro2 inner bdfz:user systemd monitor units`
- Evidence：Source-only handoff passed 10 focused and 252 full tests with exact SHA-256; target monitor files and units are new and disjoint from active workers
- Rollback：Disable and stop only curriculum-ocr-reprocess-monitor.timer/service; remove only the copied monitor script, two monitor units, and monitor output directory; do not touch OCR services or data
- Unresolved：Must stage with exact hashes, run remote systemd-analyze verify, run a manual oneshot canary, inspect latest.json, then enable timer only if acceptable

### 2026-07-16T16:14:10.145Z · change · root

- Scope：Install the exact-hash read-only monitor, enable its two-minute timer, and enable the already-running isolated shard workers for reboot resume without restarting them
- Resources：`DMITPro2 inner bdfz:curriculum-ocr-reprocess-monitor.service`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess-monitor.timer`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess@a.service`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess@b.service`
- Evidence：Remote systemd-analyze verify passed; installed hashes match local reviewed artifacts; manual oneshot produced complete telemetry with no collection errors and correctly returned warning 10 at CPU 97 C; suen Linger yes and llama already enabled
- Rollback：Disable and stop only the monitor timer/service; disable only the two reprocess instances while leaving currently running processes untouched unless an explicit stop is needed; remove only monitor artifacts if rolling back
- Unresolved：After enable verify timer schedule, worker active state and NRestarts remain unchanged; continue watching CPU GPU and available memory thresholds

### 2026-07-16T16:17:15.004Z · verify · root

- Scope：Verified the installed timer completed a recurring collection after the manual warning canary and both worker services remained uninterrupted
- Resources：`DMITPro2 inner bdfz:monitor/latest.json`、`DMITPro2 inner bdfz:monitor/events.jsonl`、`DMITPro2 inner bdfz:monitor timer and reprocess workers`
- Evidence：Recurring 2026-07-16T16:16:31Z sample is healthy_running exit 0 with no collection errors, shard progress a 147 and b 128, failed pages 0, all restart counts 0, CPU 96 C, GPU 85 C, memory 2.205 GiB, disk 325.37 GiB; timer next trigger scheduled two minutes later; workers stayed active while being enabled
- Rollback：Disable and stop only the monitor timer/service; disable the two reprocess instances if reboot resume is no longer desired without stopping the current run; remove only monitor artifacts for full rollback
- Unresolved：Thermals remain near ceilings and must be watched each two-minute sample; monitor intentionally reports only and never auto-stops or alters OCR data

### 2026-07-16T16:17:22.523Z · closeout · root

- Scope：Close the remote monitor deployment with automatic two-minute observation and reboot-resumable isolated workers active
- Resources：`DMITPro2 inner bdfz:curriculum-ocr-reprocess-monitor.timer`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess@a.service`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess@b.service`
- Evidence：Exact source hashes installed, remote systemd verification passed, manual warning sample and recurring healthy sample both behaved as designed, timer and two workers enabled, Linger yes, active workers and llama NRestarts 0
- Rollback：systemctl --user disable --now curriculum-ocr-reprocess-monitor.timer; optionally disable but do not stop the two reprocess instances; remove only monitor script units and monitor directory if required
- Unresolved：Long OCR run continues; temperature, memory, failures, stalls, restart counts and disk remain live operational risks monitored every two minutes

</details>

<details><summary><code>curriculum-remote-first-book-quality-sample-20260716</code> · 3 events · 2026-07-16T16:12:28.437Z → 2026-07-16T16:18:58.997Z</summary>

Agents：`/root/evidence_backfill_runner`
Resources：`curriculum-atlas/.cache/sources/moe-2011-01.pdf`、`/private/tmp/curriculum-remote-quality-sample/moe-2011-01`、`pages 1`、`17`、`33`、`49`、`65`、`80; /private/tmp/curriculum-remote-quality-sample/moe-2011-01/renders`、`moe-2011-01.pdf and six supplied remote Markdown samples`

### 2026-07-16T16:12:28.437Z · start · /root/evidence_backfill_runner

- Scope：Read-only visual OCR quality sample for completed remote document moe-2011-01 at physical pages 1,17,33,49,65,80
- Resources：`curriculum-atlas/.cache/sources/moe-2011-01.pdf`、`/private/tmp/curriculum-remote-quality-sample/moe-2011-01`
- Evidence：Source PDF is 83 pages and SHA256 3d205824c00c73e5323d37afb8ed9ee878919286447b72adfbe9bc487f9ffae9; all six supplied Markdown sample files are present; only temporary page renders will be created
- Rollback：Delete only temporary PNG renders; repository OCR cache remote workers and semantic gates remain read-only
- Unresolved：Need visual and textual comparison for omissions garbling tables hierarchy header footer contamination and factual character errors before classifying run impact

### 2026-07-16T16:18:46.429Z · verify · /root/evidence_backfill_runner

- Scope：Completed image-grounded comparison of six physical pages from the completed 83-page remote OCR document moe-2011-01
- Resources：`pages 1`、`17`、`33`、`49`、`65`、`80; /private/tmp/curriculum-remote-quality-sample/moe-2011-01/renders`
- Evidence：Classifications are page1 warn, page17 warn, page33 pass, page49 fail, page65 fail, page80 pass. Prose is character-accurate and running headers/page numbers are excluded. Page49 collapses distinct vertical common-character entries and Y grouping into concatenated cells; page65 misreads source 1680 竖 as 1680 坚; page1 may duplicate logo image text and page17 flattens parent-child heading levels
- Rollback：Read-only review created only six temporary PNG renders; repository OCR outputs and remote services were untouched
- Unresolved：Do not accept this document for publication until appendix and table pages receive systematic image-level row alignment and character audit; evidence does not require stopping all remote OCR computation

### 2026-07-16T16:18:58.997Z · closeout · /root/evidence_backfill_runner

- Scope：Hand off the first completed remote-book quality sample with per-page gates and run-level recommendation
- Resources：`moe-2011-01.pdf and six supplied remote Markdown samples`
- Evidence：Two pass, two warn, two fail. No whole-run stop: continue isolated remote processing, but quarantine moe-2011-01 from acceptance and require full appendix/table audit plus heading/image duplication checks before import or publication
- Rollback：No live or repository rollback applies; temporary renders may be retained as evidence or removed later
- Unresolved：The single sample proves structured-table risk but not its full-document incidence; expand targeted review across all pages in the common-character appendices and other table-heavy sections

</details>

<details><summary><code>curriculum-moe-2011-semantic-preemptive-block-20260716</code> · 4 events · 2026-07-16T16:23:04.920Z → 2026-07-16T16:27:51.392Z</summary>

Agents：`/root/evidence_backfill_runner`
Resources：`/Users/ylsuen/CF/curriculum-atlas/data/semantic-publication-policy.json`、`/Users/ylsuen/CF/curriculum-atlas/tests/semantic-publication-gate.test.mjs`

### 2026-07-16T16:23:04.920Z · start · /root/evidence_backfill_runner

- Scope：Add exact fail-closed semantic publication controls for moe-2011-01 physical pages 49 and 65 after independent image-grounded review; policy and focused tests only
- Resources：`/Users/ylsuen/CF/curriculum-atlas/data/semantic-publication-policy.json`、`/Users/ylsuen/CF/curriculum-atlas/tests/semantic-publication-gate.test.mjs`
- Evidence：Catalog binds 83 pages and source SHA-256 3d205824c00c73e5323d37afb8ed9ee878919286447b72adfbe9bc487f9ffae9; prior visual review classified page 49 table collapse and page 65 exact character mismatch
- Rollback：Restore only the two task-owned untracked files to their pre-task byte snapshots or revert the exact added profiles controls and tests; no runtime data or production resource will change
- Unresolved：Need focused validator tests full repository tests build and scoped diff; remote OCR cache output page publication manifest online source mapping and frontend are explicit exclusions

### 2026-07-16T16:27:24.728Z · change · /root/evidence_backfill_runner

- Scope：Added two profile-bound unresolved semantic controls for the image-proven moe-2011-01 defects and focused regression coverage
- Resources：`/Users/ylsuen/CF/curriculum-atlas/data/semantic-publication-policy.json`、`/Users/ylsuen/CF/curriculum-atlas/tests/semantic-publication-gate.test.mjs`
- Evidence：Page 49 uses structured-table-page and reasons table_structure_collapsed plus row_column_alignment_lost; page 65 uses exact-character-page and reason exact_character_mismatch; both bind catalog SHA-256 3d205824c00c73e5323d37afb8ed9ee878919286447b72adfbe9bc487f9ffae9 and page_count 83
- Rollback：Restore the two exact pre-task copies under /private/tmp/curriculum-moe-2011-semantic-preemptive-block-20260716 or remove only the two profiles two controls and focused assertions
- Unresolved：None in the scoped policy change; source OCR candidate still requires future receipt image adjudication and same-edition online verification before either page can resolve

### 2026-07-16T16:27:35.988Z · verify · /root/evidence_backfill_runner

- Scope：Validated exact catalog binding preemptive fail-closed behavior profile attestations repository tests typecheck build and task-scoped diff
- Resources：`/Users/ylsuen/CF/curriculum-atlas/data/semantic-publication-policy.json`、`/Users/ylsuen/CF/curriculum-atlas/tests/semantic-publication-gate.test.mjs`
- Evidence：Semantic validator reports 19 controls and policy revision 1bec2301ce6078bae7cb4c247cc1b8958961b596a13a68e514a392246baaab22; focused tests 11 of 11; full tests 255 of 255 on rerun; TypeScript passed; build produced dist from public; diff check passed; accepted fixtures for pages 49 and 65 became hidden non-citable unresolved without raw candidate text
- Rollback：No production rollback required; this was a local untracked policy and test mutation only, with exact pre-task copies retained
- Unresolved：First full-suite run had one unrelated startup-timeout timing flake in remote OCR runner; the isolated test and complete rerun both passed, and no runner code was changed

### 2026-07-16T16:27:51.392Z · closeout · /root/evidence_backfill_runner

- Scope：Hand off the completed minimal fail-closed data repair for moe-2011-01 physical pages 49 and 65
- Resources：`/Users/ylsuen/CF/curriculum-atlas/data/semantic-publication-policy.json`、`/Users/ylsuen/CF/curriculum-atlas/tests/semantic-publication-gate.test.mjs`
- Evidence：Final policy file SHA-256 9d78352871e7fa0aeb4e9d3b5a78a1227543bd80350ca0f7d1aab87ea2f8ccad; test file SHA-256 f19fef7f6933a204f75adab1e9003c6744bd1a39203f56c72c1c13cdea7945ab; policy normalized revision 1bec2301ce6078bae7cb4c247cc1b8958961b596a13a68e514a392246baaab22; all requested verification passed
- Rollback：Use exact pre-task copies in /private/tmp/curriculum-moe-2011-semantic-preemptive-block-20260716; no OCR cache remote output page manifest online mapping frontend deployment database or production resource was touched
- Unresolved：Future resolution must supply row_alignment_verified for page 49 and exact_character_verified for page 65 together with language-specific OCR source-image comparison same-edition online check and version match; until then both remain preemptively blocked

</details>

<details><summary><code>curriculum-moe-2022-03-semantic-preemptive-block-20260716</code> · 4 events · 2026-07-16T16:31:25.170Z → 2026-07-16T16:33:38.953Z</summary>

Agents：`/root/evidence_backfill_runner`
Resources：`/Users/ylsuen/CF/curriculum-atlas/data/semantic-publication-policy.json`、`/Users/ylsuen/CF/curriculum-atlas/tests/semantic-publication-gate.test.mjs`

### 2026-07-16T16:31:25.170Z · start · /root/evidence_backfill_runner

- Scope：Add exact fail-closed semantic publication controls for moe-2022-03 physical pages 75 and 109 after image-grounded review; policy and focused tests only
- Resources：`/Users/ylsuen/CF/curriculum-atlas/data/semantic-publication-policy.json`、`/Users/ylsuen/CF/curriculum-atlas/tests/semantic-publication-gate.test.mjs`
- Evidence：Catalog binds source SHA-256 3ef0ec8a30b5a950211202658df07d99f5427f750f8ba0c3cfda12736b7bd71a and page_count 109; parent image audit found p75 right-to-left column concatenation and p109 running-header promotion to a body heading
- Rollback：Restore only task-scoped pre-edit copies or remove the exact new profile controls and focused assertions; no OCR runtime production or frontend mutation is authorized
- Unresolved：Need prove p75 requires row alignment and p109 requires running-header removal; run focused full typecheck build and scoped diff

### 2026-07-16T16:33:24.877Z · change · /root/evidence_backfill_runner

- Scope：Added profile-bound unresolved semantic controls for moe-2022-03 physical pages 75 and 109 plus focused regressions
- Resources：`/Users/ylsuen/CF/curriculum-atlas/data/semantic-publication-policy.json`、`/Users/ylsuen/CF/curriculum-atlas/tests/semantic-publication-gate.test.mjs`
- Evidence：Page 75 uses structured-table-page with column_order_reversed and row_column_alignment_lost and requires row_alignment_verified; page 109 uses running-header-page with running_header_promoted_to_heading and requires running_header_removed; both bind catalog SHA-256 3ef0ec8a30b5a950211202658df07d99f5427f750f8ba0c3cfda12736b7bd71a and page_count 109
- Rollback：Restore exact task-start copies under /private/tmp/curriculum-moe-2022-03-semantic-preemptive-block-20260716 or remove only the new running-header profile two controls and focused assertions
- Unresolved：Both source pages still require future image-grounded repair and version-aware online verification; until then the controls remain unresolved fail closed

### 2026-07-16T16:33:31.831Z · verify · /root/evidence_backfill_runner

- Scope：Validated exact catalog binding preemptive accepted-page blocking defect-specific resolution attestations repository tests typecheck build and scoped diff
- Resources：`/Users/ylsuen/CF/curriculum-atlas/data/semantic-publication-policy.json`、`/Users/ylsuen/CF/curriculum-atlas/tests/semantic-publication-gate.test.mjs`
- Evidence：Focused semantic suite 14 of 14; full repository suite 258 of 258 on final rerun; TypeScript and site build passed; normalized policy has 21 controls and revision b2a5dc0d3bb6e4fcc555613319375610455d3c3ce874fdd0149e4878e43698b4; accepted fixtures for pages 75 and 109 became hidden non-citable unresolved without candidate text; diff check passed
- Rollback：No production rollback required; only local untracked policy and test files changed and exact task-start copies are retained
- Unresolved：The unrelated remote OCR startup timeout assertion was timing-flaky in an earlier full and isolated run, then passed isolated and in the complete final suite; no OCR runner source was modified

### 2026-07-16T16:33:38.953Z · closeout · /root/evidence_backfill_runner

- Scope：Hand off completed minimal fail-closed repair for moe-2022-03 physical pages 75 and 109 without touching runtime or publication artifacts
- Resources：`/Users/ylsuen/CF/curriculum-atlas/data/semantic-publication-policy.json`、`/Users/ylsuen/CF/curriculum-atlas/tests/semantic-publication-gate.test.mjs`
- Evidence：Final policy SHA-256 6bf7017b3804d8aa905b4449826d71a9b087df6f6ae0377a9b4108e7948d859a; test SHA-256 908d90dc2e21936a12abbcc8dd89425b72e9f71eec95bcf741699ddb468edc38; schema and gate hashes remained unchanged; all requested validation passed
- Rollback：Use exact pre-task copies in /private/tmp/curriculum-moe-2022-03-semantic-preemptive-block-20260716; no OCR cache remote output page manifest online mapping frontend deployment database or production resource was touched
- Unresolved：Page 75 cannot resolve without row_alignment_verified and page 109 cannot resolve without running_header_removed, each together with language-specific OCR source-image comparison same-edition online check and version match

</details>

<details><summary><code>curriculum-remote-second-book-quality-sample-20260716</code> · 2 events · 2026-07-16T16:32:13.368Z → 2026-07-17T02:04:06.324Z</summary>

Agents：`root`、`codex-root`
Resources：`/private/tmp/curriculum-remote-quality-sample/moe-2022-03`、`.cache/sources/moe-2022-03.pdf`、`DMITPro2 inner bdfz remote OCR output`、`moe-2022-03 OCR quality sample`

### 2026-07-16T16:32:13.368Z · verify · root

- Scope：Image-grounded sample review of completed remote OCR for moe-2022-03
- Resources：`/private/tmp/curriculum-remote-quality-sample/moe-2022-03`、`.cache/sources/moe-2022-03.pdf`、`DMITPro2 inner bdfz remote OCR output`
- Evidence：Pages 5 and 100 pass; pages 31 and 55 warn for punctuation or heading normalization; page 75 fails because multi-column character list is concatenated right-to-left and loses intended column order; page 109 table text is accurate but running header is promoted to a body heading
- Rollback：Read-only review only; temporary Markdown and PNG evidence may be retained until quality closeout
- Unresolved：Preemptively quarantine p75 and p109; expand image-level review across character-list ranges before accepting the full document

### 2026-07-17T02:04:06.324Z · closeout · codex-root

- Scope：Close read-only second-book quality sample after its fail findings were encoded in the semantic quarantine policy
- Resources：`moe-2022-03 OCR quality sample`
- Evidence：The sampled page risks are encoded in the fail-closed semantic publication controls
- Rollback：No mutation occurred; preserve the sample evidence
- Unresolved：The document remains blocked until page-level adjudication passes

</details>

<details><summary><code>curriculum-ocr-review-queue-20260716</code> · 4 events · 2026-07-16T16:35:15.762Z → 2026-07-16T16:42:37.394Z</summary>

Agents：`/root/ocr_review_queue`
Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/build-ocr-review-queue.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-review-queue.test.mjs`、`/private/tmp/curriculum-ocr-review-queue-smoke-20260716-gated.json`

### 2026-07-16T16:35:15.762Z · start · /root/ocr_review_queue

- Scope：Add a deterministic fail-closed read-only OCR witness audit review queue builder and focused temporary-fixture tests only
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/build-ocr-review-queue.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-review-queue.test.mjs`
- Evidence：Existing audit schema online verification standard page publication gate receiver tests dirty tree and concurrent ownership inspected; target filenames are new and disjoint
- Rollback：Remove only the two new task-owned files if rejected; no audit OCR publication manifest citation state cache or production resource is authorized for mutation
- Unresolved：Need implement exact duplicate collapse conflicting duplicate rejection deterministic priority and corrupt input fail-closed behavior, then run focused full typecheck and build checks

### 2026-07-16T16:37:34.742Z · change · /root/ocr_review_queue

- Scope：Added a standalone deterministic OCR audit review queue builder and temporary-fixture regression tests
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/build-ocr-review-queue.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-review-queue.test.mjs`
- Evidence：Builder reads only sorted witness audit JSON; excludes automatic passes; emits stable table conflict low-agreement unresolved manual blank priority; exact duplicates merge with all audit paths; conflicting duplicates malformed JSON missing fields and range drift fail closed before output write
- Rollback：Remove only the two new files; the implementation never writes witness audits OCR data page publication manifests semantic policy or citation state
- Unresolved：Need focused and repository-wide validation plus a read-only real-cache queue build outside the witness root

### 2026-07-16T16:42:29.203Z · verify · /root/ocr_review_queue

- Scope：Validated deterministic fail-closed queue generation against fixtures repository suite typecheck build and the live growing Apple Vision audit tree
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/build-ocr-review-queue.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-review-queue.test.mjs`、`/private/tmp/curriculum-ocr-review-queue-smoke-20260716-gated.json`
- Evidence：Focused tests 9 of 9; full repository tests 267 of 267; tsc passed; site build passed; real read-only snapshot parsed 3826 audit files and 3842 page records into 3823 unique queued pages, merging 19 hash-and-review-equivalent duplicates; stable uniqueness and priority checks passed; automatic gate is recomputed from evidence before exclusion
- Rollback：Delete only the two new source files and temporary smoke artifact; no witness audit OCR publication manifest semantic policy citation state or production resource was changed
- Unresolved：The live Vision drain continues so future queue snapshots will grow; current snapshot has zero automatic passes because no audited page yet satisfies the declared critical-field gate

### 2026-07-16T16:42:37.394Z · closeout · /root/ocr_review_queue

- Scope：Hand off the complete read-only OCR review queue generator and focused regression contract to the parent
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/build-ocr-review-queue.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-review-queue.test.mjs`
- Evidence：Final script SHA-256 5347650705383fa6535355ce988faee5ba7a45daba4df11fee117060e836581b; test SHA-256 5ab5d20cd222886ffff0c6d31f0f827b7b4cdd0d9a08f1a6024678397ff555c5; CLI requires --witness-root and --output outside the input tree; output has stable locators primary and witness hash-bound path aliases reasons and deterministic priority
- Rollback：Remove only the two untracked task-owned files; temporary smoke output is disposable and no runtime rollback is needed
- Unresolved：Parent may regenerate the derived queue after the evidence drain completes; queue generation intentionally never opens publication and conflicting duplicate evidence remains a hard error

</details>

<details><summary><code>curriculum-online-exact-artifact-verification-20260716</code> · 2 events · 2026-07-16T16:39:26.793Z → 2026-07-17T02:04:06.358Z</summary>

Agents：`root`、`codex-root`
Resources：`https://www.ictr.edu.cn/download_center/ywjy/p/1.html`、`ICTR 义务教育语文课程标准（2022年版） download`、`.cache/sources/moe-2022-03.pdf`、`ICTR official download identity evidence`

### 2026-07-16T16:39:26.793Z · verify · root

- Scope：Verify an independent official exact-artifact source for the 2022 Chinese curriculum standard
- Resources：`https://www.ictr.edu.cn/download_center/ywjy/p/1.html`、`ICTR 义务教育语文课程标准（2022年版） download`、`.cache/sources/moe-2022-03.pdf`
- Evidence：Located the ICTR official download item from the curriculum standards index and downloaded it for byte-level SHA and page-count comparison against the Ministry source cached locally
- Rollback：Read-only online research and temporary download only; remove /private/tmp/ictr-moe-2022-03.pdf after evidence closeout if desired
- Unresolved：Exact-artifact identity proves version match but does not itself provide independent searchable text; OCR conflicts still require image or trusted text adjudication

### 2026-07-17T02:04:06.358Z · closeout · codex-root

- Scope：Close read-only exact-artifact verification and retain its same-version identity evidence in the current quality pipeline
- Resources：`ICTR official download identity evidence`
- Evidence：Official artifact identity was established without mutating the corpus
- Rollback：No mutation occurred; preserve the identity receipt
- Unresolved：Artifact identity alone is not independent text adjudication

</details>

<details><summary><code>curriculum-atlas-ocr-review-queue</code> · 2 events · 2026-07-16T16:45:56.149Z → 2026-07-17T02:04:06.390Z</summary>

Agents：`codex-root`
Resources：`scripts/build-ocr-review-queue.mjs`、`tests/ocr-review-queue.test.mjs`、`/private/tmp/curriculum-ocr-review-queue-20260716.json`、`curriculum-atlas/scripts/build-ocr-review-queue.mjs`、`curriculum-atlas/tests/ocr-review-queue.test.mjs`

### 2026-07-16T16:45:56.149Z · verify · codex-root

- Scope：curriculum-atlas-read-only-witness-review-queue
- Resources：`scripts/build-ocr-review-queue.mjs`、`tests/ocr-review-queue.test.mjs`、`/private/tmp/curriculum-ocr-review-queue-20260716.json`
- Evidence：Focused tests 9/9 pass; live snapshot 4001 records -> 3982 unique queued pages, 19 equivalent duplicates, 0 automatic pass; output sha256 327ae712c228bce0e3f16ba82d414e5b698ab378d25ef95642eaa36212e92f5c
- Rollback：Remove only the task-scoped untracked script/test and temporary queue artifact; no OCR, audit, publication, citation, or production state changed
- Unresolved：Critical-field declarations are intentionally absent, so all pages remain fail-closed pending explicit page review

### 2026-07-17T02:04:06.390Z · closeout · codex-root

- Scope：Close duplicate read-only review-queue verification and hand the two validated source files to curriculum-atlas-full-release-20260716
- Resources：`curriculum-atlas/scripts/build-ocr-review-queue.mjs`、`curriculum-atlas/tests/ocr-review-queue.test.mjs`
- Evidence：Current review-queue focused tests pass and the queue remains fail-closed
- Rollback：Revert only the two handed-off source files
- Unresolved：The queue has zero automatic acceptance

</details>

<details><summary><code>curriculum-ocr-page-furniture-candidates-20260716</code> · 3 events · 2026-07-16T16:51:22.190Z → 2026-07-17T02:04:06.424Z</summary>

Agents：`codex-root`
Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/build-ocr-page-furniture-candidates.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-page-furniture-candidates.test.mjs`、`curriculum-atlas/scripts/build-ocr-page-furniture-candidates.mjs`、`curriculum-atlas/tests/ocr-page-furniture-candidates.test.mjs`

### 2026-07-16T16:51:22.190Z · start · codex-root

- Scope：Add a deterministic read-only candidate profiler for recurring OCR page headers and printed page-number footers; no audit filtering or publication change
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/build-ocr-page-furniture-candidates.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-page-furniture-candidates.test.mjs`
- Evidence：Dirty tree and recent ownership log inspected; both target files are new and disjoint. Live read-only evidence shows 33 documents with dominant numeric-footer profiles covering 2099 pages, including moe-2022-03 offset -7 on 95 pages.
- Rollback：Remove only the two new task-owned files and any temporary candidate artifact; active Vision drain, witness sidecars, audits, OCR caches, gates and publication remain unchanged
- Unresolved：Candidate profiles must remain pending_review and ineligible for filtering until image-grounded human approval and source/witness hash binding are implemented

### 2026-07-16T16:54:37.995Z · change · codex-root

- Scope：Added a deterministic source-bound read-only page-furniture candidate profiler and focused fixture tests
- Resources：`/Users/ylsuen/CF/curriculum-atlas/scripts/build-ocr-page-furniture-candidates.mjs`、`/Users/ylsuen/CF/curriculum-atlas/tests/ocr-page-furniture-candidates.test.mjs`
- Evidence：Profiler detects contiguous physical-to-printed page offsets and recurring first lines, records noncanonical diagnostic files, binds every document to one source PDF hash and a sidecar snapshot hash, and hard-codes eligible_for_audit_filter=false pending image review
- Rollback：Remove only these two new files; no active supervisor path imports them and no witness, audit, OCR, gate, citation or deployment state was mutated
- Unresolved：Need finish evidence drain, approve candidate ranges against source images, create a separate approval artifact, then re-audit without changing raw witness sidecars

### 2026-07-17T02:04:06.424Z · closeout · codex-root

- Scope：Hand off the deterministic read-only page-furniture candidate profiler to the full release
- Resources：`curriculum-atlas/scripts/build-ocr-page-furniture-candidates.mjs`、`curriculum-atlas/tests/ocr-page-furniture-candidates.test.mjs`
- Evidence：The focused OCR suite passes; profiler output remains pending review and ineligible for audit filtering
- Rollback：Revert only the profiler and its test
- Unresolved：No candidate rule is activated

</details>

<details><summary><code>curriculum-yuwen-2022-candidate-layer-20260716</code> · 4 events · 2026-07-16T17:01:59.686Z → 2026-07-16T17:13:16.970Z</summary>

Agents：`/root/yuwen2022_candidate_implementation`
Resources：`curriculum-atlas/data/ontology-candidates/zh-compulsory-2022.json`、`curriculum-atlas/data/ontology-candidates/candidate-layer.schema.json`、`curriculum-atlas/scripts/validate-ontology-candidate-layer.mjs`、`curriculum-atlas/tests/ontology-candidate-layer.test.mjs`、`curriculum-atlas/docs/zh-compulsory-2022-candidate-layer.md`、`curriculum-atlas/.cache/sources/moe-2022-03.pdf`

### 2026-07-16T17:01:59.686Z · start · /root/yuwen2022_candidate_implementation

- Scope：Add an isolated fail-closed candidate ontology layer for the ordinary-school 2022 compulsory Chinese curriculum standard; candidate JSON, schema, validator, focused test and short documentation only
- Resources：`curriculum-atlas/data/ontology-candidates/zh-compulsory-2022.json`、`curriculum-atlas/data/ontology-candidates/candidate-layer.schema.json`、`curriculum-atlas/scripts/validate-ontology-candidate-layer.mjs`、`curriculum-atlas/tests/ontology-candidate-layer.test.mjs`、`curriculum-atlas/docs/zh-compulsory-2022-candidate-layer.md`
- Evidence：Git status and recent agent_action_log inspected; target files do not exist and no active owner overlaps them. Source identity is moe-2022-03, SHA-256 3ef0ec8a30b5a950211202658df07d99f5427f750f8ba0c3cfda12736b7bd71a, 109 pages. Existing ontology, generated concept data, publication gates, OCR runtime, frontend, backend and deployment are explicit exclusions.
- Rollback：Remove only the five new task-owned files if rejected; no existing source, generated artifact, OCR cache or production resource will be changed.
- Unresolved：Need encode exact cumulative M0=43 and M1=64 model, page-risk and three-way gate contracts, version isolation and semantic fail-closed invariants, then run focused tests.

### 2026-07-16T17:13:08.543Z · change · /root/yuwen2022_candidate_implementation

- Scope：Added only the isolated ordinary-school 2022 compulsory Chinese candidate layer, schema, validator, focused tests and short documentation; no existing ontology, builder, public data, gate or deployment file changed
- Resources：`curriculum-atlas/data/ontology-candidates/zh-compulsory-2022.json`、`curriculum-atlas/data/ontology-candidates/candidate-layer.schema.json`、`curriculum-atlas/scripts/validate-ontology-candidate-layer.mjs`、`curriculum-atlas/tests/ontology-candidate-layer.test.mjs`、`curriculum-atlas/docs/zh-compulsory-2022-candidate-layer.md`
- Evidence：Candidate model encodes M0 43 nodes and M1 21 additional nodes for 64 cumulative; 63 parent candidate relations plus 16 stage-practice editorial alignments are all semantic_relation_allowed=false; all 64 nodes are citation_allowed=false and candidate_fail_closed; page-image/OCR/same-edition-online/version gates are blocked per anchor; pages 75 and 109 are excluded by exact semantic control IDs.
- Rollback：Remove only the five new task-owned files; existing dirty work, OCR caches, source PDF and production resources are untouched.
- Unresolved：No candidate is citation-ready or semantic-relation-ready; independent same-edition online body text, complete source-image review and accepted OCR page evidence remain pending.

### 2026-07-16T17:13:08.568Z · verify · /root/yuwen2022_candidate_implementation

- Scope：Validated source identity, exact node model, fail-closed invariants, version isolation, lexical reuse, page risks and four-by-four reviewed-inference matrix
- Resources：`curriculum-atlas/data/ontology-candidates/zh-compulsory-2022.json`、`curriculum-atlas/data/ontology-candidates/candidate-layer.schema.json`、`curriculum-atlas/scripts/validate-ontology-candidate-layer.mjs`、`curriculum-atlas/tests/ontology-candidate-layer.test.mjs`、`curriculum-atlas/.cache/sources/moe-2022-03.pdf`
- Evidence：Focused tests pass 9 of 9; validator reports M0=43, M1 added=21, total=64, parent relations=63, editorial alignments=16, semantic relations allowed=0, citation allowed nodes=0; local PDF is 20618661 bytes and SHA-256 3ef0ec8a30b5a950211202658df07d99f5427f750f8ba0c3cfda12736b7bd71a; JSON parsing and node syntax checks pass.
- Rollback：No runtime or production rollback required; remove only the five new files if rejected.
- Unresolved：Publication remains blocked by design pending image-OCR-online text triangulation and existing page publication acceptance.

### 2026-07-16T17:13:16.970Z · closeout · /root/yuwen2022_candidate_implementation

- Scope：Hand off the complete standalone fail-closed 2022 ordinary compulsory Chinese candidate layer without integration into the current ontology or publication path
- Resources：`curriculum-atlas/data/ontology-candidates/zh-compulsory-2022.json`、`curriculum-atlas/data/ontology-candidates/candidate-layer.schema.json`、`curriculum-atlas/scripts/validate-ontology-candidate-layer.mjs`、`curriculum-atlas/tests/ontology-candidate-layer.test.mjs`、`curriculum-atlas/docs/zh-compulsory-2022-candidate-layer.md`
- Evidence：Final SHA-256: candidate 44c18519873482bd34dced32830994ea15b52589789ffa648a16c812ba881dcf; schema ffd94c542e12790741ea2e89d31692a50f3ef67f82a209ac040aec20f0abd190; validator 834656ad85fba5e1ff9c7b8686f5730baa8cac2cd39d2fd8bf92b780f78206c5; test 5f5b3e332f19e510eda0e1f2ecf218ec2bfe9ef138364afa1ee121a32a46da93; docs bc5c7004b3e6c16367c2517937639b230099b3bcd7588a2b2230dbed6b197e98. Focused tests 9/9 and exact local source verification pass.
- Rollback：Delete only these five new untracked files; no existing source or external state was mutated.
- Unresolved：Nothing is unlocked: all nodes and relations remain non-citable/non-semantic until exact page evidence, image review and same-edition online text corroboration satisfy the future publication gates.

</details>

<details><summary><code>curriculum-ocr-page-furniture-approval-20260716</code> · 3 events · 2026-07-16T17:03:25.566Z → 2026-07-17T02:04:06.453Z</summary>

Agents：`codex-root`
Resources：`data/ocr-page-furniture-approvals.json`、`scripts/validate-ocr-page-furniture-approvals.mjs`、`tests/ocr-page-furniture-approvals.test.mjs`、`curriculum-atlas/data/ocr-page-furniture-approvals.json`、`curriculum-atlas/scripts/validate-ocr-page-furniture-approvals.mjs`、`curriculum-atlas/tests/ocr-page-furniture-approvals.test.mjs`

### 2026-07-16T17:03:25.566Z · start · codex-root

- Scope：Add an exact-source and exact-witness-snapshot bound manual approval ledger for visually confirmed printed-page-number footer ranges only; keep it unactivated and disconnected from audit/publication
- Resources：`data/ocr-page-furniture-approvals.json`、`scripts/validate-ocr-page-furniture-approvals.mjs`、`tests/ocr-page-furniture-approvals.test.mjs`
- Evidence：moe-2022-03 source SHA 3ef0ec8a..., 109 pages, sidecar snapshot 68b24b51...; 22 range-stratified image samples across all 8 candidate footer segments manually confirmed; no header candidate is approved
- Rollback：Remove only the three new task-owned files; active Vision drain, raw sidecars, audits, semantic gates and publication remain unchanged
- Unresolved：Must finish Vision drain and validate final snapshot before any audit consumer can activate the approval; recurring header rules remain pending

### 2026-07-16T17:06:34.517Z · change · codex-root

- Scope：Added a source-bound, witness-snapshot-bound, image-byte-bound manual footer approval ledger plus a fail-closed validator and negative tests; no consumer or audit behavior changed
- Resources：`curriculum-atlas/data/ocr-page-furniture-approvals.json`、`curriculum-atlas/scripts/validate-ocr-page-furniture-approvals.mjs`、`curriculum-atlas/tests/ocr-page-furniture-approvals.test.mjs`
- Evidence：Ledger contains 8 sorted non-overlapping ranges and 99 approved footer pages for moe-2022-03; 22 endpoint/midpoint image samples; activation_status approved_not_activated, activated false, header_rules empty; focused combined suite 16/16 and live witness binding pass
- Rollback：Remove only these three untracked files; no raw witness, audit, OCR, publication, citation or production state was modified
- Unresolved：Run full repository tests/check/build after concurrent agents settle; final Vision snapshot must be revalidated before future audit integration

### 2026-07-17T02:04:06.453Z · closeout · codex-root

- Scope：Hand off the source witness and image-bound unactivated footer approval ledger to the full release
- Resources：`curriculum-atlas/data/ocr-page-furniture-approvals.json`、`curriculum-atlas/scripts/validate-ocr-page-furniture-approvals.mjs`、`curriculum-atlas/tests/ocr-page-furniture-approvals.test.mjs`
- Evidence：The approval ledger contains only bounded source and image witnesses and remains activated false
- Rollback：Revert the ledger validator and focused test without touching OCR outputs
- Unresolved：Header rules remain empty and no approval is activated

</details>

<details><summary><code>curriculum-ocr-evidence-manifest-verifier-20260716</code> · 4 events · 2026-07-16T17:18:33.767Z → 2026-07-16T17:29:17.583Z</summary>

Agents：`/root/evidence_manifest_verifier`
Resources：`curriculum-atlas/scripts/verify-ocr-evidence-manifest.mjs`、`curriculum-atlas/tests/ocr-evidence-manifest-verifier.test.mjs`、`/private/tmp/curriculum-ocr-evidence-manifest-verification-20260716.json`

### 2026-07-16T17:18:33.767Z · start · /root/evidence_manifest_verifier

- Scope：Add a standalone read-only fail-closed verifier for manifest-scoped OCR Vision and audit evidence; script and focused tests only
- Resources：`curriculum-atlas/scripts/verify-ocr-evidence-manifest.mjs`、`curriculum-atlas/tests/ocr-evidence-manifest-verifier.test.mjs`
- Evidence：Dirty tree and recent action ownership inspected; target files are new and disjoint. Verifier inputs are an offload manifest and witness root; supervisor, audit generator, publication gates, OCR evidence and production resources are explicit exclusions.
- Rollback：Remove only the two new task-owned files and any temporary verifier output outside the witness root.
- Unresolved：Need implement exact manifest/page identity, image-byte hash, audit freshness, duplicate/extra/invalid/error sidecar checks, then run focused tests and live 5483-page validation.

### 2026-07-16T17:25:16.261Z · change · /root/evidence_manifest_verifier

- Scope：Added a standalone deterministic read-only OCR evidence manifest verifier and temporary-fixture regression suite
- Resources：`curriculum-atlas/scripts/verify-ocr-evidence-manifest.mjs`、`curriculum-atlas/tests/ocr-evidence-manifest-verifier.test.mjs`
- Evidence：Verifier validates manifest counts and identities, one canonical Vision JSON/text/image/audit per required page, image SHA and byte count, raw Vision pass references and hashes, current audit witness hash and summary, plus missing/extra/noncanonical/duplicate/invalid/error/retry/unreferenced sidecars. Output is deterministic, manifest-scoped and contains no OCR text or filesystem paths.
- Rollback：Remove only the two new task-owned files and disposable output outside the evidence root.
- Unresolved：Need run against the live 72-document 5483-page manifest after checking drain completion; any incomplete page remains a fail-closed result, not a publication pass.

### 2026-07-16T17:29:17.553Z · verify · /root/evidence_manifest_verifier

- Scope：Validated the standalone verifier with focused adversarial fixtures and the completed live manifest-scoped Apple Vision evidence set
- Resources：`curriculum-atlas/scripts/verify-ocr-evidence-manifest.mjs`、`curriculum-atlas/tests/ocr-evidence-manifest-verifier.test.mjs`、`/private/tmp/curriculum-ocr-evidence-manifest-verification-20260716.json`
- Evidence：Node syntax and diff whitespace pass; focused tests 8 of 8 cover deterministic success, missing/extra/page-zero/duplicate/noncanonical evidence, identity and image drift, stale audit, malformed JSON, scoped retry/error/unreferenced raw pass, malformed manifest and output containment. Live byte-level run passed 72 of 72 documents and 5483 of 5483 pages with zero issues; manifest SHA 3050f22e7bda3cb5aafb1817bc861b7f7b8d65e358dbbba3b5a0b35af4b27c8f and evidence snapshot SHA 2cecbb77429004e8fd167b08463f0d49a13af1b92206694e2fd2379a9b384342.
- Rollback：Delete only the two new source/test files and disposable /private/tmp summary; no evidence, supervisor, audit, publication, cache or production state changed.
- Unresolved：Twenty-six prior sandbox diagnostic JSON files, including six intentional XPC error samples, remain outside the four canonical evidence namespaces and are explicitly ignored; scoped errors inside vision, images, audits or vision-passes still fail closed.

### 2026-07-16T17:29:17.583Z · closeout · /root/evidence_manifest_verifier

- Scope：Hand off the complete read-only OCR evidence manifest verification contract and live 5483-page proof
- Resources：`curriculum-atlas/scripts/verify-ocr-evidence-manifest.mjs`、`curriculum-atlas/tests/ocr-evidence-manifest-verifier.test.mjs`、`/private/tmp/curriculum-ocr-evidence-manifest-verification-20260716.json`
- Evidence：Final SHA-256: script 25d24e33a55b952c9c1109b6630a7aa244e2d489739026ffae436a6e24dfc9e5; test aa270a6d739df8654ddde774e918324a74c51cb1af091a4b7509153ffede09d4; live summary d135ed61c36a79c558c3e067d0cd2d69e7de9fc16ffbbeeb837683512e967f2e. CLI returns pass with 72 documents, 5483 pages, zero issues and deterministic evidence snapshot hash.
- Rollback：Remove only the two untracked task-owned files and temporary summary; all OCR evidence remains byte-identical and read-only.
- Unresolved：No verifier blocker. This proves evidence identity/completeness/freshness, not OCR semantic correctness or publication eligibility; image adjudication and same-edition online checks remain separate gates.

</details>

<details><summary><code>curriculum-ocr-page-furniture-impact-preview-20260716</code> · 3 events · 2026-07-16T17:19:37.049Z → 2026-07-17T02:04:06.482Z</summary>

Agents：`codex-root`
Resources：`curriculum-atlas/scripts/preview-ocr-page-furniture-impact.mjs`、`curriculum-atlas/tests/ocr-page-furniture-impact.test.mjs`、`/private/tmp/curriculum-moe-2022-03-page-furniture-impact.json`

### 2026-07-16T17:19:37.049Z · start · codex-root

- Scope：Add a read-only preview that measures the exact before/after OCR comparison impact of approved but unactivated page-footer rules, without changing audits or gates
- Resources：`curriculum-atlas/scripts/preview-ocr-page-furniture-impact.mjs`、`curriculum-atlas/tests/ocr-page-furniture-impact.test.mjs`、`/private/tmp/curriculum-moe-2022-03-page-furniture-impact.json`
- Evidence：Vision drain completed 5,483/5,483; moe-2022-03 approval ledger live binding passes for 8 ranges and 99 pages; audit currently has no approved furniture consumer
- Rollback：Remove only the two new task-owned files and temporary preview; raw OCR, Vision sidecars, audits, gates, candidate ontology and public data remain unchanged
- Unresolved：Preview must prove exact trailing-line-only removal and report impact before any audit integration is considered

### 2026-07-16T17:21:19.465Z · change · codex-root

- Scope：Added an exact trailing-footer-only, source-bound read-only comparison preview and quantified its impact on moe-2022-03 without mutating audits or gates
- Resources：`curriculum-atlas/scripts/preview-ocr-page-furniture-impact.mjs`、`curriculum-atlas/tests/ocr-page-furniture-impact.test.mjs`、`/private/tmp/curriculum-moe-2022-03-page-furniture-impact.json`
- Evidence：Live preview covers 99 approved pages: witness footer removed on 99, primary on 0, numeric exact 0 to 27, mean normalized agreement 0.935862 to 0.940107, 96 pages improved, title exact unchanged at 17; all policy mutations none
- Rollback：Remove only the preview script/test and temporary report; approval ledger remains unactivated and raw evidence/audits/publication are unchanged
- Unresolved：Focused rerun and full suite pending; header furniture requires separate page-specific review because footer removal alone leaves most title/numeric conflicts unresolved

### 2026-07-17T02:04:06.482Z · closeout · codex-root

- Scope：Hand off the read-only trailing-footer impact preview without activating any OCR or publication consumer
- Resources：`curriculum-atlas/scripts/preview-ocr-page-furniture-impact.mjs`、`curriculum-atlas/tests/ocr-page-furniture-impact.test.mjs`
- Evidence：The preview remains a local read-only measurement and the focused suite passes
- Rollback：Revert only the preview script and test
- Unresolved：Header conflicts and activation remain separately gated

</details>

<details><summary><code>curriculum-yuwen-2022-online-claim-evidence-20260716</code> · 4 events · 2026-07-16T17:20:27.082Z → 2026-07-16T17:34:33.359Z</summary>

Agents：`/root/yuwen2022_online_verification`
Resources：`curriculum-atlas/data/online-verification/zh-compulsory-2022-claims.json`、`curriculum-atlas/data/online-verification/zh-compulsory-2022-claims.schema.json`、`curriculum-atlas/scripts/validate-zh-compulsory-2022-online-verification.mjs`、`curriculum-atlas/tests/zh-compulsory-2022-online-verification.test.mjs`、`curriculum-atlas/docs/zh-compulsory-2022-online-verification.md`

### 2026-07-16T17:20:27.082Z · start · /root/yuwen2022_online_verification

- Scope：Add a task-scoped fail-closed online claim verification artifact, schema, validator, focused test and short documentation for moe-2022-03; exclude candidate layer, ontology, builders, public data, existing publication gates, package scripts, deployment and all live resources
- Resources：`curriculum-atlas/data/online-verification/zh-compulsory-2022-claims.json`、`curriculum-atlas/data/online-verification/zh-compulsory-2022-claims.schema.json`、`curriculum-atlas/scripts/validate-zh-compulsory-2022-online-verification.mjs`、`curriculum-atlas/tests/zh-compulsory-2022-online-verification.test.mjs`、`curriculum-atlas/docs/zh-compulsory-2022-online-verification.md`
- Evidence：Git main is ahead of origin by one commit and has extensive unrelated dirty work; active owners are disjoint and this task uses new unique paths only. Source artifact identity is moe-2022-03 SHA-256 3ef0ec8a30b5a950211202658df07d99f5427f750f8ba0c3cfda12736b7bd71a.
- Rollback：Remove only the five task-scoped new files; no existing repository or production state will be restored or reset
- Unresolved：Focused artifact must preserve publication_unlock=false for every claim, mark nine goals partial/conflicted, treat ICTR as same-artifact mirror, and quarantine version mismatches and OCR conflicts

### 2026-07-16T17:33:38.861Z · change · /root/yuwen2022_online_verification

- Scope：Added a standalone fail-closed same-edition online claim evidence artifact, JSON schema, semantic validator, adversarial focused tests and boundary documentation for moe-2022-03 without integrating any publication path
- Resources：`curriculum-atlas/data/online-verification/zh-compulsory-2022-claims.json`、`curriculum-atlas/data/online-verification/zh-compulsory-2022-claims.schema.json`、`curriculum-atlas/scripts/validate-zh-compulsory-2022-online-verification.mjs`、`curriculum-atlas/tests/zh-compulsory-2022-online-verification.test.mjs`、`curriculum-atlas/docs/zh-compulsory-2022-online-verification.md`
- Evidence：Artifact records 17 sources, 9 independent exact-edition web sources, six locked claims, three version mismatches and five source-image-wins conflicts. ICTR is explicitly same_artifact_mirror with zero independent evidence; nine goals are partial_conflicted and the known goal 6 error is rejected.
- Rollback：Delete only the five new task-owned files; no existing candidate, ontology, builder, public data, gate, package or production resource was changed
- Unresolved：No publication eligibility is asserted; all publication_unlock values remain false and interpretive alignment remains nonnormative and semantically inert

### 2026-07-16T17:34:05.318Z · verify · /root/yuwen2022_online_verification

- Scope：Validated the standalone 2022 compulsory Chinese online claim evidence contract and its fail-closed adversarial behavior
- Resources：`curriculum-atlas/data/online-verification/zh-compulsory-2022-claims.json`、`curriculum-atlas/data/online-verification/zh-compulsory-2022-claims.schema.json`、`curriculum-atlas/scripts/validate-zh-compulsory-2022-online-verification.mjs`、`curriculum-atlas/tests/zh-compulsory-2022-online-verification.test.mjs`、`curriculum-atlas/docs/zh-compulsory-2022-online-verification.md`
- Evidence：Validator returned valid true with 17 sources, 9 independent sources, 6 of 6 claims locked, 3 version mismatches, 5 transcription conflicts and zero errors. Node focused plus adjacent online-verification tests passed 18 of 18; jq parse, Node syntax and trailing-whitespace checks passed.
- Rollback：No runtime or production mutation occurred; remove only the five task-owned files to revert
- Unresolved：Evidence remains deliberately publication-locked; the nine-goal list still requires another complete authoritative independent exact-edition text before any status upgrade

### 2026-07-16T17:34:33.359Z · closeout · /root/yuwen2022_online_verification

- Scope：Hand off the complete task-scoped fail-closed online verification layer for the 2022 ordinary compulsory Chinese standard
- Resources：`curriculum-atlas/data/online-verification/zh-compulsory-2022-claims.json`、`curriculum-atlas/data/online-verification/zh-compulsory-2022-claims.schema.json`、`curriculum-atlas/scripts/validate-zh-compulsory-2022-online-verification.mjs`、`curriculum-atlas/tests/zh-compulsory-2022-online-verification.test.mjs`、`curriculum-atlas/docs/zh-compulsory-2022-online-verification.md`
- Evidence：Final SHA-256: artifact 15a725818645e5f699da7415f9636ca1b0e33d0423c58709a02bbd822b178e0e; schema 7d76fea787ac56d8a4e1038cad431b60af232532c48dc136fcc5b052b8281022; validator 65c405dd065a95776a4e770c0d29726147d3edf9ad179d0c45b3c71c0d637cb5; test b62b5d859e324b131604042f4d0623cb79cb11a65a2897d5f0c8487382b837b2; docs 91d48f18fff132e1abb8e0ac96eecf179e792b0394ccd2a0cbf623fda1bd7126. Tests passed 18 of 18 and validator reports zero errors.
- Rollback：Delete only these five untracked task-owned files; no existing repository file, OCR evidence, Cloudflare resource or live site state was mutated
- Unresolved：All claims remain publication_unlock false. Nine goals remain partial_conflicted; interpretive alignment remains normative false and semantic_relation_allowed false.

</details>

<details><summary><code>curriculum-atlas-browser-qa-20260716</code> · 4 events · 2026-07-16T17:27:37.657Z → 2026-07-16T18:10:38.484Z</summary>

Agents：`codex-root`
Resources：`curriculum-atlas/public/index.html`、`curriculum-atlas/tests`、`curriculum-atlas/.wrangler/local-state`、`http://localhost:8788`、`curriculum-atlas/public/app.js`、`curriculum-atlas/public/atlas.js`、`curriculum-atlas/tests/mobile-workbench-layout.test.mjs`、`curriculum-atlas/tests/subject-facets.test.mjs`、`curriculum-atlas/.wrangler/state/v3/d1`、`local Wrangler D1 QA state`、`Playwright curriculum-atlas-qa session`、`curriculum-atlas frontend checkpoint`、`Playwright curriculum-atlas-qa`、`local Wrangler preview`

### 2026-07-16T17:27:37.657Z · start · codex-root

- Scope：Browser-verify and surgically repair the curriculum atlas main starmap shell: remove the redundant CSP-blocked inline import map, initialize the repository local D1 only for QA, and verify single-subject fit plus all-hidden semantics; no production deploy or remote data mutation
- Resources：`curriculum-atlas/public/index.html`、`curriculum-atlas/tests`、`curriculum-atlas/.wrangler/local-state`、`http://localhost:8788`
- Evidence：1920x1080 browser QA reproduced one CSP violation from the self-mapping inline importmap and three API 500 responses caused by local D1 missing documents and subject_insights tables; git status and recent task ownership were inspected and no active disjoint agent owns public/index.html or local D1 QA state
- Rollback：Restore only the removed redundant importmap block if needed and discard disposable local Wrangler state; production Worker D1 R2 auth and deployment remain untouched
- Unresolved：Need run local migrations, reload with zero console errors, then exercise single-subject auto-fit, all-hidden filtering, search and workbench behavior

### 2026-07-16T17:41:28.989Z · change · codex-root

- Scope：Removed the redundant CSP-blocked inline import map, switched all frontend module/data cache keys to one v13 generation, initialized only the disposable local D1 QA state, and made single-facet curriculum-course stars inherit the selected subject color with a diamond identity marker
- Resources：`curriculum-atlas/public/index.html`、`curriculum-atlas/public/app.js`、`curriculum-atlas/public/atlas.js`、`curriculum-atlas/tests/mobile-workbench-layout.test.mjs`、`curriculum-atlas/tests/subject-facets.test.mjs`、`curriculum-atlas/.wrangler/state/v3/d1`
- Evidence：Local migrations 0001-0005 completed; browser API requests changed from 500 missing-table errors to 200; CSP console errors changed from one to zero; single 语文 state has 143 valid nodes and the 3 reviewed 生活语文 course nodes now render in 语文 pink as diamonds instead of science-like green; focused frontend tests 17/17 and TypeScript check pass
- Rollback：Restore only the removed importmap and frontend color/cache hunks if rejected; delete disposable local Wrangler state to reset local QA; no production Worker D1 R2 deployment or remote OCR state changed
- Unresolved：Need independent read-only review, full repository suite, mobile browser pass, and production deployment remains intentionally blocked behind data/OCR gates

### 2026-07-16T18:10:28.520Z · verify · codex-root

- Scope：Completed local real-browser and repository regression verification for the v14 star-map interaction and course-node semantics
- Resources：`curriculum-atlas/public/index.html`、`curriculum-atlas/public/app.js`、`curriculum-atlas/public/atlas.js`、`curriculum-atlas/tests/mobile-workbench-layout.test.mjs`、`curriculum-atlas/tests/subject-facets.test.mjs`、`local Wrangler D1 QA state`、`Playwright curriculum-atlas-qa session`
- Evidence：Browser reloaded v14 with zero console errors and all local APIs HTTP 200; one click isolates 语文; accessible canvas text identifies diamond course nodes and circular subject concepts; graph tests prove hide-all has zero node or edge leakage and 运动能力 never enters 语文; full tests 326 of 326, check and build pass
- Rollback：Revert only the task-owned frontend and test hunks and rebuild dist; local D1 QA state is disposable; no live Cloudflare resource was deployed
- Unresolved：Production deployment remains blocked behind OCR intake, semantic adjudication and final production smoke gates

### 2026-07-16T18:10:38.484Z · closeout · codex-root

- Scope：Closed the local frontend QA checkpoint with task-owned browser and preview processes removed
- Resources：`curriculum-atlas frontend checkpoint`、`Playwright curriculum-atlas-qa`、`local Wrangler preview`
- Evidence：Named browser session closed, Wrangler preview exited, orphan cleanup dry-run found zero cliDaemon processes; remaining playwright-mcp processes are app-owned and were not touched; screenshot stored under curriculum-atlas/output/playwright/curriculum-atlas-qa/.playwright-cli
- Rollback：No runtime rollback is needed because this checkpoint was local-only; frontend source hunks remain independently reversible
- Unresolved：The site is not claimed deployed or complete; continued OCR and ontology expansion are still required before release

</details>

<details><summary><code>curriculum-remote-ocr-intentional-pause-monitor-20260716</code> · 4 events · 2026-07-16T18:00:49.968Z → 2026-07-16T18:10:10.636Z</summary>

Agents：`codex-root`
Resources：`curriculum-atlas/scripts/monitor-remote-ocr-reprocess.mjs`、`curriculum-atlas/tests/remote-ocr-reprocess-monitor.test.mjs`、`curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.service`、`DMITPro2 inner bdfz monitor only`、`curriculum-atlas/tests/remote-ocr-offload-runner.test.mjs`、`DMITPro2 inner bdfz monitor script and user unit`、`DMITPro2 inner bdfz curriculum-ocr-reprocess-monitor.service`、`curriculum-ocr-reprocess-monitor.timer`、`curriculum-ocr-reprocess@a.service`、`curriculum-ocr-reprocess@b.service`、`curriculum-ocr-llama.service`、`curriculum-atlas monitor files`

### 2026-07-16T18:00:49.968Z · start · codex-root

- Scope：Teach the read-only remote OCR monitor an explicit operator-paused shard state so the safety pause is reported as warning rather than a false OCR failure, while preserving fail-closed behavior for real failures and active-while-paused drift
- Resources：`curriculum-atlas/scripts/monitor-remote-ocr-reprocess.mjs`、`curriculum-atlas/tests/remote-ocr-reprocess-monitor.test.mjs`、`curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.service`、`DMITPro2 inner bdfz monitor only`
- Evidence：Current monitor reads valid persisted B progress but reports SHARD_B_INTERRUPTED and WORKER_B_NOT_ACTIVE critical solely because B was intentionally stopped and disabled after the memory gate; A and llama remain healthy
- Rollback：Restore the prior monitor script/unit and daemon-reload; this change never starts stops retries or modifies OCR workers or evidence
- Unresolved：Need focused/full tests, remote hash readback, systemd unit verification, and a live warning snapshot with B paused and A advancing

### 2026-07-16T18:09:55.980Z · change · codex-root

- Scope：Deployed a pause-aware read-only OCR monitor and systemd unit to DMITPro2 inner bdfz; classified the intentional B pause as warning while retaining critical gates for memory pressure and active-while-paused drift; stabilized the wall-timeout test so it cannot be preempted by its startup branch under full-suite load
- Resources：`curriculum-atlas/scripts/monitor-remote-ocr-reprocess.mjs`、`curriculum-atlas/tests/remote-ocr-reprocess-monitor.test.mjs`、`curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.service`、`curriculum-atlas/tests/remote-ocr-offload-runner.test.mjs`、`DMITPro2 inner bdfz monitor script and user unit`
- Evidence：Remote readback hashes match local: monitor f8bea627ac675bb0b7e16500afba47bee89bd61ef7cc544204f6a895ae3f9b36 and unit 3d3d9cbc198177795792b1a60fa093b6217e63089470b9b25691eb5991c64f64; candidate syntax and systemd-analyze verification passed
- Rollback：Restore the two timestamped pre-paused-shard-20260716T1808Z remote backups, daemon-reload, and rerun the monitor; OCR worker services and evidence were not modified
- Unresolved：B remains intentionally disabled until sustained memory and thermal headroom justify a controlled resume

### 2026-07-16T18:10:02.773Z · verify · codex-root

- Scope：Verified the pause-aware monitor live without touching OCR execution state
- Resources：`DMITPro2 inner bdfz curriculum-ocr-reprocess-monitor.service`、`curriculum-ocr-reprocess-monitor.timer`、`curriculum-ocr-reprocess@a.service`、`curriculum-ocr-reprocess@b.service`、`curriculum-ocr-llama.service`
- Evidence：Live 18:08:32Z snapshot is warning exit 10 with only SHARD_B_OPERATOR_PAUSED; A active with zero restarts, B inactive disabled with Result success, llama healthy, timer active waiting; 1433 of 6364 pages complete, zero failed pages, memory 2.099 GiB, CPU 96C, GPU 66C
- Rollback：Restore the timestamped monitor backups and daemon-reload; resume B only with systemctl enable and start after a separate safety decision
- Unresolved：A current English batch is still active; latest state contains 96 completed English pages and its log mtime is advancing even while the page counter waits for the next atomic batch commit

### 2026-07-16T18:10:10.636Z · closeout · codex-root

- Scope：Released the monitor-only pause-state correction with a live warning snapshot and preserved fail-closed resource gates
- Resources：`curriculum-atlas monitor files`、`DMITPro2 inner bdfz monitor only`
- Evidence：Focused monitor tests pass 11 of 11; full repository suite passes 326 of 326; TypeScript check and static build pass; remote monitor now distinguishes operator pause from OCR failure and still blocked correctly during a transient 0.813 GiB memory sample before returning to warning at 2.099 GiB
- Rollback：Use the exact remote pre-paused-shard backups and daemon-reload; no OCR content or worker state rollback is needed
- Unresolved：This closes only monitor semantics; OCR and publication work remain active and B must stay paused until a reviewed resource plan permits resume

</details>

<details><summary><code>curriculum-atlas-progress-report-20260716</code> · 2 events · 2026-07-16T18:11:46.099Z → 2026-07-16T18:11:51.615Z</summary>

Agents：`codex-root`
Resources：`reports/cloudflare_business_audit_2026-05-23.md`、`reports/vps_fleet_status_2026-05-23.md`

### 2026-07-16T18:11:46.099Z · change · codex-root

- Scope：Appended the verified OCR safety pause, pause-aware monitor, local frontend QA, rollback, and unresolved release gates to the canonical Cloudflare and VPS reports
- Resources：`reports/cloudflare_business_audit_2026-05-23.md`、`reports/vps_fleet_status_2026-05-23.md`
- Evidence：Canonical section starts at line 22872 and VPS checkpoint at line 1486; both record 1433 of 6364 pages, zero failures, B preserved at 683, A active at 750, live warning-only monitor state, local-only frontend verification, and exact rollback boundaries
- Rollback：Remove only the two appended dated Curriculum Atlas sections; no runtime resource is coupled to the report text
- Unresolved：Progress values are a timestamped checkpoint and will advance; overall OCR, adjudication, production deployment, and release verification remain open

### 2026-07-16T18:11:51.615Z · closeout · codex-root

- Scope：Verified and released the two timestamped report appendices without changing any operational state
- Resources：`reports/cloudflare_business_audit_2026-05-23.md`、`reports/vps_fleet_status_2026-05-23.md`
- Evidence：Both headings resolve exactly once by line search; tail readback preserves prior report content and contains no secret, cookie, session, student data, or raw OCR payload
- Rollback：Delete only the exact appended dated sections if superseded or rejected
- Unresolved：Future checkpoints should append newer evidence rather than rewriting this timestamped snapshot

</details>

<details><summary><code>curriculum-ocr-resume-accelerate-20260716</code> · 7 events · 2026-07-16T23:38:16.354Z → 2026-07-17T02:04:06.574Z</summary>

Agents：`codex-root`
Resources：`curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.service`、`curriculum-atlas/tests/remote-ocr-reprocess-monitor.test.mjs`、`DMITPro2 inner bdfz machine_thermal_guard.py`、`curriculum-ocr-reprocess@a.service`、`curriculum-ocr-reprocess@b.service`、`curriculum-ocr-reprocess-monitor.service`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess@a.service`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess@b.service`、`DMITPro2 inner bdfz:bdfz-machine-thermal-guard.service`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess-monitor.service`、`20260716T1520Z-partial14-reprocess`、`curriculum-ocr-llama.service`、`curriculum-ocr-reprocess-monitor.timer`、`curriculum-atlas test and build suite`、`reports/cloudflare_business_audit_2026-05-23.md`、`reports/vps_fleet_status_2026-05-23.md`、`reports/dmitpro2_inner_bdfz_machine_audit_rollcall_2026-06-22.md`、`backups/reports/2026-07-16/curriculum-ocr-resume-prechange-20260716T1703PDT`、`three operations reports`、`report backup SHA256SUMS`、`DMITPro2 OCR monitor and services`、`DMITPro2 partial14 monitor`、`A and B OCR shards`、`llama health`、`thermal guard`、`DMITPro2 guarded OCR runtime`

### 2026-07-16T23:38:16.354Z · start · codex-root

- Scope：Resume the isolated DMITPro2 curriculum OCR B shard and accelerate both shards through a guarded CPU policy after fixing A timeout-risk; update only pause-state monitor semantics and the existing thermal guard, preserve all OCR hashes and publication gates
- Resources：`curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.service`、`curriculum-atlas/tests/remote-ocr-reprocess-monitor.test.mjs`、`DMITPro2 inner bdfz machine_thermal_guard.py`、`curriculum-ocr-reprocess@a.service`、`curriculum-ocr-reprocess@b.service`、`curriculum-ocr-reprocess-monitor.service`
- Evidence：Preflight: A 1086 pages, B 683, failures zero; B sidecar valid; 28 consecutive normal thermal samples, current CPU about 50C GPU 46C memory about 3.1 to 3.3 GiB; A has four retry_wait documents caused by 300-second idle timeouts under the 75-percent cap, with English at attempt 4 of 5
- Rollback：Restore timestamped monitor and thermal-guard backups, daemon-reload or restart only those observers, stop and disable B, and return A to the prior 75-percent guarded quota; OCR page state remains append-only and resumable
- Unresolved：Must prove the revised guard preserves thermal and memory gates, remove paused-shard monitor flag before B start, observe B resume without failure, and stop B immediately if memory or thermal gates recur

### 2026-07-17T00:01:53.689Z · change · codex-root

- Scope：Resumed isolated OCR shard B and raised adaptive dual-shard quotas while preserving thermal emergency stops and OCR publication gates
- Resources：`DMITPro2 inner bdfz:curriculum-ocr-reprocess@a.service`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess@b.service`、`DMITPro2 inner bdfz:bdfz-machine-thermal-guard.service`、`DMITPro2 inner bdfz:curriculum-ocr-reprocess-monitor.service`、`curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.service`、`curriculum-atlas/tests/remote-ocr-reprocess-monitor.test.mjs`
- Evidence：B enabled and resumed at 2026-07-16T23:51Z from validated 683-page state; normal dual quota 150 percent each, warning 100, critical 50, emergency 25; monitor pause flag removed and stall window 600 to 900 seconds; active guard hash 63863cdf4db579cc0ec2c19a9174d97b04bacaea7140bdc2ad12103d1a7f5aa1 and monitor hash de7955a28e85d0128750077e86275b91af9a32646388948d674507a0499c1470
- Rollback：Stop and disable only B, restore monitor service pre-b-resume-20260716T2350Z and reviewed thermal-guard pre-high-load backup, daemon-reload and restart monitor timer; preserve all OCR outputs and sidecars
- Unresolved：Continue guarded observation; remote OCR remains non-citable until whole-document audit, Apple Vision and exact checks, online same-version verification and adjudication pass

### 2026-07-17T00:01:53.825Z · verify · codex-root

- Scope：Verified resumed A and B throughput, resource guard response, page artifact hashes and local monitor regression
- Resources：`20260716T1520Z-partial14-reprocess`、`curriculum-ocr-reprocess@a.service`、`curriculum-ocr-reprocess@b.service`、`curriculum-ocr-llama.service`、`curriculum-ocr-reprocess-monitor.timer`、`curriculum-atlas test and build suite`
- Evidence：By 2026-07-17T00:01Z A reached 1118 and B 699, total 1817 of 6364 with zero failed or quarantined pages; resumed A and B batches each added 16 pages and all 64 result and Markdown SHA-256 comparisons passed; monitor healthy_running, all three services active with zero restarts, llama health 200, no kernel OOM; full test rerun 326 of 326, typecheck and isolated build passed
- Rollback：Same component-scoped rollback as change row; no Cloudflare or website data rollback is required because no OCR evidence was imported or deployed
- Unresolved：Transient CPU reached 97C and memory 0.937 GiB, causing automatic 50 then 100 percent throttling; keep emergency stop gates and continue observation

### 2026-07-17T00:06:25.783Z · change · codex-root

- Scope：Appended the verified dual-shard resume checkpoint to the canonical Cloudflare, VPS and DMITPro2 audit reports
- Resources：`reports/cloudflare_business_audit_2026-05-23.md`、`reports/vps_fleet_status_2026-05-23.md`、`reports/dmitpro2_inner_bdfz_machine_audit_rollcall_2026-06-22.md`、`backups/reports/2026-07-16/curriculum-ocr-resume-prechange-20260716T1703PDT`
- Evidence：Append-only sections record scope, baseline and current pages, quality hashes, adaptive thresholds, peak and recovered resources, test results, rollback and ongoing non-citable status; all three prechange copies have a verified SHA256SUMS manifest
- Rollback：Restore the three checksummed report copies from curriculum-ocr-resume-prechange-20260716T1703PDT; this documentation rollback does not alter the active OCR services
- Unresolved：OCR remains in progress and report snapshot will age; later whole-run completion must append a new evidence checkpoint rather than rewrite history

### 2026-07-17T00:06:25.876Z · verify · codex-root

- Scope：Verified report changes are append-only, backups are byte-valid and the live OCR checkpoint remains healthy
- Resources：`three operations reports`、`report backup SHA256SUMS`、`DMITPro2 OCR monitor and services`
- Evidence：Each report begins with its exact prechange bytes and only adds one checkpoint; all three backup hashes pass; no whitespace errors were emitted; 00:03Z monitor healthy_running at 1817 of 6364, failed zero, A B llama active, zero restarts, quotas restored to 150 percent, memory 2.457 GiB and no OOM
- Rollback：Restore the checksummed copies for docs; stop and disable only B plus restore the pre-b-resume monitor unit for runtime rollback
- Unresolved：Continue automatic monitoring of retries, thermal state, memory and next atomic batches

### 2026-07-17T02:04:06.542Z · verify · codex-root

- Scope：Verify guarded OCR runtime before source and runtime ownership transfer while the services intentionally continue unattended
- Resources：`DMITPro2 partial14 monitor`、`A and B OCR shards`、`llama health`、`thermal guard`
- Evidence：At 2026-07-17T01:26Z the run had 2153 of 6364 pages, A 1294 and B 859, failed and quarantined zero, A B llama active, restart counts zero and llama HTTP 200; monitor correctly returned MEMORY_BELOW_MINIMUM with 0.641 GiB available, CPU 95 C, GPU 67 C, thermal warn and quota 100
- Rollback：The existing guard stops and disables only the exact worker selected by consecutive memory or emergency thermal conditions; preserve all state and timestamped monitor backups
- Unresolved：Do not increase load under the current memory warning

### 2026-07-17T02:04:06.574Z · closeout · codex-root

- Scope：Release source and runtime ownership to curriculum-atlas-full-release-20260716 while the guarded OCR services intentionally continue unattended
- Resources：`curriculum-atlas/ops/systemd/curriculum-ocr-reprocess-monitor.service`、`curriculum-atlas/tests/remote-ocr-reprocess-monitor.test.mjs`、`DMITPro2 guarded OCR runtime`
- Evidence：Source-focused OCR monitor receiver and supervisor tests pass; the last remote snapshot was healthy except for its explicit fail-closed memory warning
- Rollback：Stop and disable only B if the existing consecutive memory or emergency thermal gate fires; restore timestamped monitor and thermal-guard backups; preserve append-only OCR state
- Unresolved：Publication remains blocked until OCR completion whole-document receipt dual witness online same-version verification and adjudication

</details>

<details><summary><code>curriculum-atlas-asset-data-integrity-20260716</code> · 6 events · 2026-07-17T00:25:26.877Z → 2026-07-17T01:13:20.503Z</summary>

Agents：`codex-root`
Resources：`curriculum-atlas:data asset registry`、`curriculum-atlas:lineage checks`、`curriculum-atlas:D1 import release protocol`、`curriculum-atlas:R2 metadata manifest`、`curriculum-atlas:tests and audit report`、`curriculum-atlas/scripts/build-project-operations-ledger.mjs`、`curriculum-atlas/docs/project-operations-ledger.md`、`curriculum-atlas/tests/project-operations-ledger.test.mjs`、`curriculum-atlas/package.json`、`curriculum-atlas/README.md`、`curriculum-atlas/docs/operations.md`、`curriculum-atlas:operations ledger tests`、`curriculum-atlas:catalog disposition tests`、`curriculum-atlas/data/artifact-registry.json`、`curriculum-atlas/migrations/0006_corpus_import_release.sql`、`curriculum-atlas/scripts/build-corpus.mjs`、`curriculum-atlas/scripts/import-corpus.mjs`、`curriculum-atlas/src/index.ts`、`curriculum-atlas/data/release-assets-policy.json`、`curriculum-atlas/scripts/build-release-manifest.mjs`、`curriculum-atlas/scripts/publish-metadata.mjs`、`curriculum-atlas/docs/project-asset-ledger.md`、`curriculum-atlas/docs/project-data-integrity-audit-2026-07-16.md`、`reports/cloudflare_business_audit_2026-05-23.md`、`curriculum-atlas npm verification`、`curriculum-atlas Downloads asset audit`、`curriculum-atlas release manifest`、`curriculum-atlas local D1 dialect fixture`、`canonical report backup`、`curriculum-atlas local source data tests and documentation`、`canonical Cloudflare operations report`

### 2026-07-17T00:25:26.877Z · start · codex-root

- Scope：Audit and harden the curriculum-atlas asset ledger, data lineage, D1 publication consistency, R2/Assets release parity, and documentation without deploying production
- Resources：`curriculum-atlas:data asset registry`、`curriculum-atlas:lineage checks`、`curriculum-atlas:D1 import release protocol`、`curriculum-atlas:R2 metadata manifest`、`curriculum-atlas:tests and audit report`
- Evidence：Pre-mutation git status shows main ahead one with 24 modified and 47 untracked prior-work items; baseline npm test 326 of 326 and TypeScript check pass; read-only audits confirmed five unregistered PDFs, stale R2 queue/catalog, D1 schema 0004, non-atomic corpus import, and local-preview-production drift
- Rollback：Revert only task-scoped new registry/check/report files and surgical import/publish hardening hunks; preserve all pre-existing dirty OCR, graph, frontend, backend, cache and remote worker state; no production rollback is needed because deployment is excluded
- Unresolved：Must finish cross-layer asset disposition, snapshot-safe import, release manifest parity, focused tests, full verification, and canonical operations report update before any deploy decision

### 2026-07-17T00:34:20.810Z · change · codex-root

- Scope：Added a reproducible project operations ledger covering inception through the current audit with complete append-only event detail and discoverability from README and operations docs
- Resources：`curriculum-atlas/scripts/build-project-operations-ledger.mjs`、`curriculum-atlas/docs/project-operations-ledger.md`、`curriculum-atlas/tests/project-operations-ledger.test.mjs`、`curriculum-atlas/package.json`、`curriculum-atlas/README.md`、`curriculum-atlas/docs/operations.md`
- Evidence：Ledger reconstructs 69 curriculum tasks and 331 action-log events, separates local preview production OCR and publication states, records Git history external deployment snapshots known data risks rollback rules and unmatched closeouts, and is 361 KB with 3341 lines
- Rollback：Remove only the generator focused test package script README link operations notice and generated ledger; append-only source action log remains unchanged
- Unresolved：Ledger must be regenerated after the concurrent asset D1 and release-manifest tasks append their final events

### 2026-07-17T00:34:20.943Z · verify · codex-root

- Scope：Verified the reproducible operations ledger structure completeness and explicit text-quality source contract
- Resources：`curriculum-atlas:operations ledger tests`、`curriculum-atlas:catalog disposition tests`
- Evidence：Focused tests 4 of 4 pass; generator syntax passes; every locally available curriculum action-log timestamp phase and agent is present; standalone clones skip only the workspace-log parity check
- Rollback：No runtime rollback is needed because this is documentation source and tests only
- Unresolved：Rerun npm run ops:ledger once all parallel hardening work is complete so the final ledger includes every new action event

### 2026-07-17T01:13:20.311Z · change · codex-root

- Scope：Completed local-only asset registry, explicit catalog text-quality contracts, release-scoped D1 corpus import, versioned R2 manifest reader, complete operations documentation and canonical report append
- Resources：`curriculum-atlas/data/artifact-registry.json`、`curriculum-atlas/migrations/0006_corpus_import_release.sql`、`curriculum-atlas/scripts/build-corpus.mjs`、`curriculum-atlas/scripts/import-corpus.mjs`、`curriculum-atlas/src/index.ts`、`curriculum-atlas/data/release-assets-policy.json`、`curriculum-atlas/scripts/build-release-manifest.mjs`、`curriculum-atlas/scripts/publish-metadata.mjs`、`curriculum-atlas/docs/project-operations-ledger.md`、`curriculum-atlas/docs/project-asset-ledger.md`、`curriculum-atlas/docs/project-data-integrity-audit-2026-07-16.md`、`reports/cloudflare_business_audit_2026-05-23.md`
- Evidence：Asset registry accounts for 245 PDF paths and 209 unique entities; catalog has 196 explicit dispositions and 101 native text documents; corpus release binds 101 text assets 16456 paragraphs 6031 page gates and 91 hashed chunks; R2 policy governs 16 immutable objects and the Worker verifies current pointer manifest and object integrity
- Rollback：Restore only task-scoped source and documentation hunks; canonical report prechange copy and SHA are under backups/reports/2026-07-16/curriculum-atlas-data-integrity-prechange-20260716T1811PDT; no remote rollback is required because no deploy or D1 R2 write occurred
- Unresolved：Preview and production remain blocked by migrations 0005 and 0006 plus unverified versioned R2 readers; OCR has zero accepted pages or documents and the working tree remains dirty

### 2026-07-17T01:13:20.406Z · verify · codex-root

- Scope：Verified the full local integrity and release-preflight chain without remote mutation
- Resources：`curriculum-atlas npm verification`、`curriculum-atlas Downloads asset audit`、`curriculum-atlas release manifest`、`curriculum-atlas local D1 dialect fixture`、`canonical report backup`
- Evidence：npm run verify passed 353 of 353 tests TypeScript catalog asset corpus concept online-verification build release manifest and Wrangler dry-run; Downloads audit passed 15 of 15 relevant artifacts; local D1 applied 0001 through 0006 and rejected finalize without receipts; report prechange prefix hash remains exact
- Rollback：Generated catalog corpus concept dist release manifest and ledger are reproducible; restore the recorded report copy for documentation rollback; no live resource rollback applies
- Unresolved：4900 OCR pages unfinished 6091 unresolved 783 image-review 73 blank-confirmation one quarantine two derived lineage gaps and non-Chinese ontology depth remain

### 2026-07-17T01:13:20.503Z · closeout · codex-root

- Scope：Closed the local project-ledger and data-integrity audit with fail-closed production boundaries preserved
- Resources：`curriculum-atlas local source data tests and documentation`、`canonical Cloudflare operations report`
- Evidence：All task-owned local checks pass and every discovered asset has an explicit disposition; local preview production OCR publication and release states are separated in the reproducible ledger; no production or remote OCR state was changed
- Rollback：Use task-scoped source reversal and the checksummed canonical-report prechange copy; preserve all pre-existing dirty work and OCR evidence
- Unresolved：A later separately authorized preview window must apply 0005 and 0006 deploy the versioned reader import the corpus activate the R2 pointer and complete browser dependency verification before production can be considered

</details>

<details><summary><code>curriculum-atlas-release-manifest-20260716</code> · 4 events · 2026-07-17T00:28:54.606Z → 2026-07-17T00:51:01.400Z</summary>

Agents：`codex-runtime-asset-parity`
Resources：`curriculum-atlas/scripts/build-release-manifest.mjs`、`curriculum-atlas/scripts/publish-metadata.mjs`、`curriculum-atlas/tests/release-manifest.test.mjs`、`curriculum-atlas/data/release-assets-policy.json`

### 2026-07-17T00:28:54.606Z · start · codex-runtime-asset-parity

- Scope：Implement local release manifest and strict R2 asset parity checks only; no remote writes or deployment
- Resources：`curriculum-atlas/scripts/build-release-manifest.mjs`、`curriculum-atlas/scripts/publish-metadata.mjs`、`curriculum-atlas/tests/release-manifest.test.mjs`、`curriculum-atlas/data/release-assets-policy.json`
- Evidence：Target paths were clean; parent owns broader audit and delegated these disjoint files
- Rollback：Remove the three new files and restore only scripts/publish-metadata.mjs from its pre-task Git content
- Unresolved：Production and preview migration 0005 remain pending and are explicit release blockers

### 2026-07-17T00:38:08.081Z · change · codex-runtime-asset-parity

- Scope：Added deterministic source/data/graph/static release manifest policy and replaced fixed six-file R2 publisher with fail-closed manifest-driven upload and post-upload parity
- Resources：`curriculum-atlas/data/release-assets-policy.json`、`curriculum-atlas/scripts/build-release-manifest.mjs`、`curriculum-atlas/scripts/publish-metadata.mjs`、`curriculum-atlas/tests/release-manifest.test.mjs`
- Evidence：Policy governs 15 R2 objects; static public assets are auto-enumerated; local preview production revisions and pending 0005 are bound; publisher checks blocker before command execution
- Rollback：Remove new policy builder and test, restore only publish-metadata.mjs from Git; no remote mutation occurred
- Unresolved：Focused manifest test is intentionally blocked until concurrently regenerated concept graphs carry the new catalog hash

### 2026-07-17T00:51:01.367Z · verify · codex-runtime-asset-parity

- Scope：Verified release manifest syntax, project asset audit binding, immutable versioned R2 staging, pointer ordering, stale dist detection and focused failure behavior
- Resources：`curriculum-atlas/data/release-assets-policy.json`、`curriculum-atlas/scripts/build-release-manifest.mjs`、`curriculum-atlas/scripts/publish-metadata.mjs`、`curriculum-atlas/tests/release-manifest.test.mjs`
- Evidence：Project asset audit ok with 245 PDFs and 209 unique artifacts; focused pure and interruption tests 4 of 4 pass; simulated second staging put failure never writes release/current.json; current builder rejects stale dist graph hash before publication
- Rollback：Remove new policy builder and test and restore only publish-metadata.mjs; no R2 D1 Worker Assets or Pages mutation occurred
- Unresolved：Root owner must run npm run build after data settles then rerun all six release tests; preview and production remain blocked by pending 0005 and 0006 plus stable-key Worker readers

### 2026-07-17T00:51:01.400Z · closeout · codex-runtime-asset-parity

- Scope：Hand off manifest-driven fail-closed release implementation without deployment
- Resources：`curriculum-atlas/data/release-assets-policy.json`、`curriculum-atlas/scripts/build-release-manifest.mjs`、`curriculum-atlas/scripts/publish-metadata.mjs`、`curriculum-atlas/tests/release-manifest.test.mjs`
- Evidence：16 policy-driven data objects receive immutable releases release_id keys; full release manifest readback precedes the sole mutable current pointer write; source and dist sets hashes bytes counts Git tree graph fingerprints asset registry and audit summaries are bound
- Rollback：Task-scoped file rollback only; immutable staging is unreachable unless current pointer activates and no remote command was run in this task
- Unresolved：Do not publish until dist parity passes, 0005 and 0006 are applied, Worker reads versioned manifest pointer, environment snapshot is refreshed and full focused tests pass

</details>

<details><summary><code>curriculum-atlas-full-release-20260716</code> · 28 events · 2026-07-17T01:21:35.286Z → 2026-07-17T06:35:37.437Z</summary>

Agents：`codex-root`、`root`、`codex-production-qa`
Resources：`curriculum-atlas source and release artifacts`、`bdfz-curriculum-atlas-preview`、`bdfz-curriculum-atlas`、`bdfz-curriculum-atlas-preview D1`、`bdfz-curriculum-atlas D1`、`bdfz-curriculum-atlas-sources-preview`、`bdfz-curriculum-atlas-sources`、`curriculum.bdfz.net`、`reports/agent_action_log.jsonl`、`backups/curriculum-atlas/2026-07-16/full-release-prechange-20260716T1821PDT`、`backups/reports/2026-07-16/curriculum-atlas-full-release-prechange-20260716T190921PDT`、`reports/cloudflare_business_audit_2026-05-23.md`、`R2 bdfz-ops-backups curriculum-atlas prefix`、`curriculum-atlas`、`data-corpus`、`Downloads-PDF-inventory`、`curriculum-atlas-git`、`bdfz-curriculum-atlas-preview-D1`、`migrations-0005-0006`、`worker:bdfz-curriculum-atlas-preview`、`preview assets and bindings`、`D1:bdfz-curriculum-atlas-preview`、`corpus-f56f6fac3e022bb24ad69265`、`R2:bdfz-curriculum-atlas-sources-preview`、`release-b1c8c31d00e0016ad885ae5c9e92cad1`、`curriculum-atlas/src/ai.ts`、`curriculum-atlas/src/types.ts`、`curriculum-atlas/public/app.js`、`curriculum-atlas/public/subject-facets.js`、`curriculum-atlas/tests`、`curriculum-atlas/docs/data-methodology.md`、`curriculum-atlas/docs/concept-evolution-academic-model.md`、`curriculum-atlas taxonomy and AI contract tests`、`curriculum-atlas in-memory SQLite migration replay`、`migration:0007_document_taxonomy_contract.sql`、`backup:preview-taxonomy-prechange-20260717T042528Z`、`DMITPro2 inner bdfz workstation`、`user-unit:curriculum-ocr-reprocess@b.service`、`run:20260716T1520Z-partial14-reprocess`、`corpus:corpus-358471fcce862b2f0ae446fc`、`release:release-841a528f0086ce69f2f7a6f2d07c0999`、`R2:bdfz-curriculum-atlas-sources-preview/release/current.json`、`R2:releases/release-841a528f0086ce69f2f7a6f2d07c0999`、`R2:releases/release-841a528f0086ce69f2f7a6f2d07c0999/catalog/ingest-manifest.json`、`Playwright:curriculum-preview-api-qa`、`my.bdfz.net`、`nav.bdfz.net`、`apis.bdfz.net`、`pulse.bdfz.net`、`local registration surfaces`、`backup:production-prechange-20260717T052301Z`、`worker:bdfz-curriculum-atlas`、`D1:bdfz-curriculum-atlas`、`R2:bdfz-curriculum-atlas-sources`、`migrations:0005-0007`、`release:release-9cb02f77c06ee0535e7981a22b312373`、`pointer:release/current.json`、`R2:bdfz-curriculum-atlas-sources/release/current.json`、`R2:releases/release-9cb02f77c06ee0535e7981a22b312373`、`https://curriculum.bdfz.net/api/source-manifest`、`backups/reports/2026-07-16/curriculum-atlas-full-release-20260717T061502Z`、`curriculum-ocr-llama.service`、`bdfz-curriculum-atlas-D1`、`Playwright`、`/private/tmp/curriculum-production-qa`

### 2026-07-17T01:21:35.286Z · start · codex-root

- Scope：Release the reviewed curriculum-atlas v9 data-integrity stack through preview and production, then continue the existing guarded OCR quality pipeline until all eligible text and graph data are published
- Resources：`curriculum-atlas source and release artifacts`、`bdfz-curriculum-atlas-preview`、`bdfz-curriculum-atlas`、`bdfz-curriculum-atlas-preview D1`、`bdfz-curriculum-atlas D1`、`bdfz-curriculum-atlas-sources-preview`、`bdfz-curriculum-atlas-sources`、`curriculum.bdfz.net`
- Evidence：Preflight confirms main at f464de0 ahead of origin by one, all current dirty paths are curriculum project work recorded by prior closed tasks, local full verification previously passed 353 of 353, and five registration surfaces already contain the stable curriculum entry
- Rollback：Create a task-scoped source backup and Git backup branch before staging; export or bookmark each D1, preserve the current R2 pointer or explicit bootstrap absence, and retain prior Worker versions before any remote write
- Unresolved：Must refresh live ownership, migrations, pointer and OCR state; freeze a clean release commit; pass preview migrations, corpus, pointer and browser gates before production; active remote OCR resources remain under the existing curriculum OCR task and are not mutated by the release lane

### 2026-07-17T02:10:06.367Z · change · codex-root

- Scope：Closed 19 superseded curriculum task ownership records, replaced the unsafe portable source backup with a sanitized checksummed archive, and registered the private OCR archive prefix before any R2 write
- Resources：`reports/agent_action_log.jsonl`、`backups/curriculum-atlas/2026-07-16/full-release-prechange-20260716T1821PDT`、`backups/reports/2026-07-16/curriculum-atlas-full-release-prechange-20260716T190921PDT`、`reports/cloudflare_business_audit_2026-05-23.md`、`R2 bdfz-ops-backups curriculum-atlas prefix`
- Evidence：Only curriculum-atlas-full-release-20260716 remains open; sanitized archive path audit passed, package.json extraction was byte exact and archive SHA-256 is 15ef3cb273ce5df78277166f8411e242136a7cc11516747e939c8ccdd36dcf47; report prechange SHA-256 is df0461f0f7534266898849dc55255a9566c091955a5b65311c2b7ea2ffad8858
- Rollback：Restore the report from the checksummed prechange copy; retain both source backups locally at mode 0600 and never upload the original archive that captured browser-session state
- Unresolved：Encrypted R2 archive creation and full readback restore verification remain pending; no R2 backup object has been written yet

### 2026-07-17T02:30:41.967Z · verify · root

- Scope：local release data and source asset closure
- Resources：`curriculum-atlas`、`data-corpus`、`Downloads-PDF-inventory`
- Evidence：catalog 196; Downloads 15 of 15 relevant PDFs registered; corpus 196 documents 16456 paragraphs 91 chunks; concept graph 553 episodes 475 relations; exact 13-table counts; 366 of 368 tests passed with only stale generated operations ledger remaining
- Rollback：no remote mutation; backup branch and sanitized local source archive retained
- Unresolved：regenerate operations ledger after final precommit action-log cutoff; preview and production remain undeployed

### 2026-07-17T02:35:23.128Z · change · root

- Scope：commit complete release-governed source and data tree
- Resources：`curriculum-atlas-git`
- Evidence：commit 4d69a8f277a6be93667d9fdd541cdbe206bd1401; 113 reviewed paths; 368 of 368 tests; TypeScript and Worker dry-run pass; gitleaks staged no findings
- Rollback：backup branch backup/curriculum-full-release-20260716-1821 and sanitized source archive retained
- Unresolved：push and Cloudflare preview/production publication pending

### 2026-07-17T02:47:19.800Z · change · root

- Scope：apply preview D1 publication and corpus release migrations
- Resources：`bdfz-curriculum-atlas-preview-D1`、`migrations-0005-0006`
- Evidence：Time Travel bookmark 0000000e-000025b0-000050ab-0b35c96ad034e6fe62d697d9f9f9b4aa; migrations 0005 and 0006 applied; bootstrap ready; 196 documents 16456 paragraphs 16456 FTS; comments and reports unchanged at zero; one online verification scoped; exact core counts match
- Rollback：restore preview D1 to recorded Time Travel bookmark; restore Worker version 2459045b-9337-477e-af09-571bcd91dcab if needed
- Unresolved：preview Worker deploy and corpus import in progress

### 2026-07-17T03:02:39.081Z · change · root

- Scope：deploy preview Worker v9 with Git-bound release provenance and versioned R2 reader
- Resources：`worker:bdfz-curriculum-atlas-preview`、`preview assets and bindings`
- Evidence：Worker version d5d9798b-b4c7-41e2-ba94-97df546951b1 deployed at 100 percent; cache-busted health reports 2026.07.16-v9, Git 7bd37463a11a34f1951d04eeefa87c7d81028e62, versioned_manifest_v1, all five bindings and exact bootstrap core counts
- Rollback：deploy preview Worker version 2459045b-9337-477e-af09-571bcd91dcab at 100 percent; D1 rollback remains the recorded preview Time Travel bookmark
- Unresolved：91-chunk preview corpus import is in progress and APIs remain fail-closed until finalization; R2 current pointer not yet activated

### 2026-07-17T03:31:37.180Z · change · root

- Scope：import all preview corpus chunks with resumable fail-closed receipts and contain finalization CPU fault
- Resources：`D1:bdfz-curriculum-atlas-preview`、`corpus-f56f6fac3e022bb24ad69265`
- Evidence：91 of 91 declared chunks have exact receipts; live rows are 196 documents, 16456 paragraphs, 16456 FTS and 6031 page gates; comments and reports remain zero; one network interruption resumed from contiguous chunk 076; monolithic finalization hit D1 code 7429 and was reset, leaving state failed and API 503
- Rollback：restore preview D1 to bookmark 0000000e-000025b0-000050ab-0b35c96ad034e6fe62d697d9f9f9b4aa and deploy Worker 2459045b-9337-477e-af09-571bcd91dcab if the tested finalization repair cannot activate exact counts
- Unresolved：replace the unindexed FTS paragraph_id invariant with bounded rowid-based verification, pass tests, then resume finalization without reimporting verified chunks

### 2026-07-17T03:38:21.089Z · change · root

- Scope：activate exact preview corpus release with bounded rowid finalization
- Resources：`D1:bdfz-curriculum-atlas-preview`、`corpus-f56f6fac3e022bb24ad69265`
- Evidence：release ready; 91 of 91 chunk receipts; 196 documents; 16456 paragraphs and FTS rows; 6031 page gates; zero FTS identity mismatches; health HTTP 200 no-store; taxonomy 196 classified as 160 subject 16 course 20 scope 0 unclassified
- Rollback：restore preview D1 to bookmark 0000000e-000025b0-000050ab-0b35c96ad034e6fe62d697d9f9f9b4aa and Worker version 2459045b-9337-477e-af09-571bcd91dcab
- Unresolved：preview release evidence R2 pointer browser QA and production rollout remain pending

### 2026-07-17T03:46:58.454Z · change · root

- Scope：publish and atomically activate preview versioned metadata release
- Resources：`R2:bdfz-curriculum-atlas-sources-preview`、`release-b1c8c31d00e0016ad885ae5c9e92cad1`
- Evidence：17 immutable objects uploaded and each GET byte-hash verified; manifest 108130 bytes SHA256 084e5f00b7e8ed51589ee22bcf0bf156f0179b7abc66167507eb2cf2c97a3bec; current pointer read back exact; preview release ready and corpus-bound
- Rollback：restore or write a prior verified release/current.json pointer; if required restore preview Worker and D1 using recorded anchors
- Unresolved：read-only API smoke found raw subject meta and document classification disagreement for 汉语; production is blocked until controlled taxonomy contract is repaired and preview reverified

### 2026-07-17T04:20:21.494Z · change · root

- Scope：close taxonomy contract gaps across AI citations metadata facet browsing and migration proof
- Resources：`curriculum-atlas/src/ai.ts`、`curriculum-atlas/src/types.ts`、`curriculum-atlas/public/app.js`、`curriculum-atlas/public/subject-facets.js`、`curriculum-atlas/tests`、`curriculum-atlas/docs/data-methodology.md`、`curriculum-atlas/docs/concept-evolution-academic-model.md`
- Evidence：AI citations now retain taxonomy kind and display facet; metadata facet browsing includes related assessment identities while exact subject filters remain ordinary-subject only; v1 to v2 integration test covers all 196 rows and 28 query identities
- Rollback：restore only the listed task-owned files to taxonomy handoff state before any commit or deployment
- Unresolved：full governed corpus rebuild verification commit push and preview release remain pending

### 2026-07-17T04:20:21.521Z · verify · root

- Scope：independent local taxonomy closure verification before corpus regeneration
- Resources：`curriculum-atlas taxonomy and AI contract tests`、`curriculum-atlas in-memory SQLite migration replay`
- Evidence：TypeScript passed; 52 focused tests passed; SQLite 0007 replay yielded integrity ok 159 subjects 1 assessment subject 16 courses 20 non-course scopes 12 facets 28 query identities and zero row drift
- Rollback：no remote state changed
- Unresolved：generated corpus is intentionally still old and must be rebuilt before any D1 import

### 2026-07-17T04:29:15.286Z · change · root

- Scope：apply preview taxonomy schema v2 with fresh rollback anchors
- Resources：`D1:bdfz-curriculum-atlas-preview`、`migration:0007_document_taxonomy_contract.sql`、`backup:preview-taxonomy-prechange-20260717T042528Z`
- Evidence：Sole pending migration applied; no migrations remain; 196 classifications equal 159 subject plus 1 assessment subject plus 16 courses plus 3 assessment domains plus 4 source collections plus 13 cross-cutting frameworks; 12 facets and 28 query identities; comments reports AI logs and audit logs remain zero
- Rollback：Restore D1 only if necessary to Time Travel bookmark 00000033-00000004-000050ab-5b86ee1fc56f8d50372b697fe7675345; Worker and R2 predecessor anchors retained
- Unresolved：Deploy v10, import corpus-358471fcce862b2f0ae446fc, collect fresh evidence, then activate a new preview R2 release

### 2026-07-17T04:34:32.581Z · change · root

- Scope：deploy preview Worker v10 from clean pushed taxonomy source
- Resources：`worker:bdfz-curriculum-atlas-preview`、`preview assets and bindings`
- Evidence：Version 2d107d38-cf31-49b6-82b1-20b32a32e824 serves 100 percent; health HTTP 200 no-store reports 2026.07.16-v10, Git 40cb114e410e5f2afc886732eb146707edf8477b, classification schema 2, 159 subject plus 1 assessment identity, 12 facets, 16 courses, 20 scopes and all five bindings
- Rollback：Redeploy preview Worker version d5d9798b-b4c7-41e2-ba94-97df546951b1 at 100 percent and restore D1 only if required to bookmark 00000033-00000004-000050ab-5b86ee1fc56f8d50372b697fe7675345
- Unresolved：New 91-chunk corpus import is active; release evidence, R2 pointer, browser QA and production remain pending

### 2026-07-17T04:37:58.412Z · change · root

- Scope：protect remote OCR shard B after consecutive low-memory gate
- Resources：`DMITPro2 inner bdfz workstation`、`user-unit:curriculum-ocr-reprocess@b.service`、`run:20260716T1520Z-partial14-reprocess`
- Evidence：Read-only samples were 981131264 and 966483968 bytes MemAvailable, both below the one-GiB stop gate; B had 1259 of 3182 pages, zero failed pages and zero quarantine; explicit user-unit stop left MainPID zero and NRestarts zero while MemAvailable recovered to 2839844 kB
- Rollback：Resume only the same B unit from its append-only state after sustained memory and runtime preflight passes; do not reset attempts, start A, or alter old output roots
- Unresolved：Verify controlled exit status 75 preserved hashes and attempts; establish sustained resume gate before restarting B

### 2026-07-17T05:05:27.704Z · change · root

- Scope：import and activate corrected preview corpus under resumable exact receipts
- Resources：`D1:bdfz-curriculum-atlas-preview`、`corpus:corpus-358471fcce862b2f0ae446fc`
- Evidence：91 of 91 remote receipt names hashes and bytes equal the local manifest; two client interruptions were isolated at uncommitted 030 and 072 then resumed exactly; final state ready with 196 documents 16456 paragraphs and FTS rows 6031 page gates 12 facets 28 query identities zero orphans and comments reports AI logs audit logs all zero; health HTTP 200
- Rollback：Restore D1 to Time Travel bookmark 00000033-00000004-000050ab-5b86ee1fc56f8d50372b697fe7675345 and Worker d5d9798b-b4c7-41e2-ba94-97df546951b1 only if exact preview repair cannot remain healthy
- Unresolved：Collect Git-bound preview environment evidence, commit and push the receipt, publish a successor R2 release, then complete browser and dependency QA

### 2026-07-17T05:16:20.344Z · change · root

- Scope：publish and atomically activate corrected preview versioned metadata release
- Resources：`R2:bdfz-curriculum-atlas-sources-preview`、`release:release-841a528f0086ce69f2f7a6f2d07c0999`
- Evidence：predecessor pointer re-read exact at 388 bytes SHA256 52c5e8ddb8c8d6633c73f54005732b76c6d35c633b5d8a500570b0c2ffbe3ed3; preview release ready with zero blockers; 17 immutable objects staged and publisher readback passed before current pointer activation
- Rollback：restore prior verified release/current.json pointer for release-b1c8c31d00e0016ad885ae5c9e92cad1; D1 bookmark and Worker predecessor remain separately recorded
- Unresolved：complete independent preview browser API and dependency QA before any production mutation

### 2026-07-17T05:16:28.661Z · verify · root

- Scope：independent post-activation preview R2 readback
- Resources：`R2:bdfz-curriculum-atlas-sources-preview/release/current.json`、`R2:releases/release-841a528f0086ce69f2f7a6f2d07c0999`
- Evidence：new pointer 388 bytes SHA256 65395a8b4fbca18f24aa36b37b54c72ae7e7b5f9071635a07e6285822cd0e12f; manifest 109499 bytes SHA256 7891b0989694070ade46686a8b26118fca1f74cc98b025b9252c1616f6277f3d; all 17 objects total 545536 bytes exact; ingest manifest 55183 bytes SHA256 0f0fda279b10ef40011ea28477deb528ed5d45b7478dfd93fc6e49ebd623c2463df296bc43fb73c5
- Rollback：write back the backed-up predecessor pointer only; immutable successor objects may remain safely unreferenced
- Unresolved：preview browser API negative-write and dependent-surface verification pending

### 2026-07-17T05:16:38.352Z · verify · root

- Scope：correct prior ingest manifest hash transcription while preserving append-only log
- Resources：`R2:releases/release-841a528f0086ce69f2f7a6f2d07c0999/catalog/ingest-manifest.json`
- Evidence：authoritative post-readback ingest manifest identity is 55183 bytes SHA256 0f0fda279b10ef40011ea28477deb528ed5d45b7478dfd93a8b7bf6d0b1cb16e; the immediately preceding log row contained a manual hash transcription error only
- Rollback：none; correction is append-only and no remote state changed
- Unresolved：use this correction row as authoritative for the ingest manifest hash

### 2026-07-17T05:21:22.099Z · verify · root

- Scope：preview API taxonomy research and negative-write regression after corrected R2 activation
- Resources：`worker:bdfz-curriculum-atlas-preview`、`D1:bdfz-curriculum-atlas-preview`、`R2:bdfz-curriculum-atlas-sources-preview`、`Playwright:curriculum-preview-api-qa`
- Evidence：health 200 v10 Git 40cb114 five bindings; corpus 196 documents 16456 paragraphs and FTS 6031 gates 91 chunks; exact 12 facets 28 query identities one Han assessment identity 16 courses; unfiltered limit 200 returns 196; Chinese returns 10 without Han; Han query 400; technical detail remains curriculum_course; compare 10 documents and 3 insights; search 6 passages; source manifest 196; AI 401 and invalid-Origin comment 403; D1 before and after comments reports rate limits AI citation logs and content audit logs all zero
- Rollback：restore predecessor R2 pointer and recorded preview Worker D1 anchors if a later visual gate reveals a release defect
- Unresolved：independent desktop mobile Canvas and route visual QA still running; production untouched

### 2026-07-17T05:22:21.544Z · verify · root

- Scope：preview leaf dependency and public registration smoke
- Resources：`my.bdfz.net`、`nav.bdfz.net`、`apis.bdfz.net`、`pulse.bdfz.net`、`local registration surfaces`
- Evidence：site-auth.js 200 text/javascript 41536 bytes; anonymous session 200 unauthenticated; live nav sites.json 200 and contains curriculum.bdfz.net; APIS health 200 status ok model gemini-3.1-flash-lite with 43 active keys and disabled indices reported; Pulse meta and 24h range both 200 and contain curriculum; local User Center registry nav portal Companion and Pulse source entries all present; authenticated /api/sites correctly returns 401 to anonymous
- Rollback：none; read-only probes only
- Unresolved：production custom-domain regression and authenticated event write verification remain for production closeout

### 2026-07-17T05:26:29.936Z · change · root

- Scope：persist fresh production rollback anchors before any production mutation
- Resources：`backup:production-prechange-20260717T052301Z`、`worker:bdfz-curriculum-atlas`、`D1:bdfz-curriculum-atlas`、`R2:bdfz-curriculum-atlas-sources`
- Evidence：active deployment 4f2042f6-ce2c-40c0-a7a0-06f48188726b version 7d1766b2-32be-4ce1-9528-f6c69bb2a092; D1 bookmark 0000002b-00002585-000050ab-8645885d977dc9bf5678e6cdf12b084f; pending migrations 0005 0006 0007; baseline 196 documents 16456 paragraphs and legacy FTS 196 classifications 3 rate-limit rows 2 AI logs; versioned R2 pointer absent; production untouched
- Rollback：anchor file is additive; no production rollback needed because probes were read-only
- Unresolved：visual preview gate must pass before using these anchors for production rollout

### 2026-07-17T05:40:10.659Z · change · root

- Scope：apply production schema v3 taxonomy v2 migrations and deploy v10 Worker
- Resources：`D1:bdfz-curriculum-atlas`、`migrations:0005-0007`、`worker:bdfz-curriculum-atlas`
- Evidence：all three migrations applied with none pending; legacy corpus remains readable at 196 documents and 16456 paragraphs; taxonomy exact 159 subject 1 assessment subject 16 courses 20 scopes 12 facets 28 query identities; comments and reports remain zero with 3 rate-limit rows and 2 AI logs preserved; version 28c7e6d4-1638-42bc-b371-bd8d24210b93 deployed 100 percent and custom-domain health recovered to HTTP 200 v10 Git 57487dc with legacy-bootstrap corpus
- Rollback：restore D1 bookmark 0000002b-00002585-000050ab-8645885d977dc9bf5678e6cdf12b084f and Worker 7d1766b2-32be-4ce1-9528-f6c69bb2a092 if forward repair fails
- Unresolved：import and activate exact corpus-358471fcce862b2f0ae446fc then collect evidence and bootstrap versioned R2

### 2026-07-17T06:08:17.292Z · change · root

- Scope：import and atomically finalize corrected production corpus with exact resumable receipts
- Resources：`D1:bdfz-curriculum-atlas`、`corpus:corpus-358471fcce862b2f0ae446fc`
- Evidence：91 of 91 receipt names hashes and bytes equal local manifest from 000-core.sql through 090-paragraphs.sql; normalized local and remote receipt SHA256 b5dd616c553a2cc35b3deafcc36d6d1bc2bf2573e718ecc3e5c2608c502acfaf; final state ready at 196 documents 16456 paragraphs and FTS rows 6031 page gates 16456 displayed zero accepted OCR and zero finalizer drift; health HTTP 200
- Rollback：Restore D1 bookmark 0000002b-00002585-000050ab-8645885d977dc9bf5678e6cdf12b084f and Worker 7d1766b2-32be-4ce1-9528-f6c69bb2a092 only if forward repair fails and no later legitimate user writes exist
- Unresolved：Production R2 metadata readback and browser API Pulse QA still running; OCR accepted documents remain fail-closed at zero pending governed OCR completion

### 2026-07-17T06:08:25.698Z · change · root

- Scope：bootstrap and atomically activate first production versioned metadata release after full release gate
- Resources：`R2:bdfz-curriculum-atlas-sources`、`release:release-9cb02f77c06ee0535e7981a22b312373`、`pointer:release/current.json`
- Evidence：Immediately before bootstrap pointer was absent; release manifest production readiness true with zero blockers after 380 of 380 tests; publisher staged and verified 17 immutable objects then activated current pointer for release-9cb02f77c06ee0535e7981a22b312373; ingest manifest verified at 55183 bytes SHA256 0f0fda279b10ef40011ea28477deb528ed5d45b7478dfd93a8b7bf6d0b1cb16e
- Rollback：Delete only release/current.json to restore v10 stable-key fallback; leave immutable release objects unreferenced; full D1 Worker rollback requires the separately recorded coupled anchor
- Unresolved：Independent full pointer manifest 17-object local-source readback and production browser API Pulse QA are active

### 2026-07-17T06:11:05.002Z · verify · root

- Scope：independent post-activation production R2 and API source-manifest readback
- Resources：`R2:bdfz-curriculum-atlas-sources/release/current.json`、`R2:releases/release-9cb02f77c06ee0535e7981a22b312373`、`https://curriculum.bdfz.net/api/source-manifest`
- Evidence：Pointer stable across two reads at 388 bytes SHA256 5142166d000fbf82e6d0a9d135a5340ba3c9d77f3bed803967ad565ff8c2133a; manifest 107777 bytes SHA256 a6a15ea83cc58b1b84f5587a110c0fddeb414f24c77ff534507ea96868c03964; 17 unique release-prefixed objects total 546648 bytes match manifest and local sources with zero mismatch; API returns exact 55183-byte 196-entry ingest manifest SHA256 0f0fda279b10ef40011ea28477deb528ed5d45b7478dfd93a8b7bf6d0b1cb16e
- Rollback：Delete only production release/current.json to restore verified v10 stable-key fallback; preserve immutable release objects
- Unresolved：Production browser API D1 negative-write and Pulse QA still running; OCR accepted data remains pending quality closure

### 2026-07-17T06:15:35.045Z · change · root

- Scope：Create exact local rollback copy before canonical operations-report refresh
- Resources：`reports/cloudflare_business_audit_2026-05-23.md`、`backups/reports/2026-07-16/curriculum-atlas-full-release-20260717T061502Z`
- Evidence：Source and backup are both SHA256 eb4b1bd04fcb3dfbfcc7d522636d96ba7cfd3e16f2ba070dcfed20fe8eaac5dd
- Rollback：Restore the copied report only if the scoped report edit fails validation; no production resource changed
- Unresolved：Report update waits for final production browser QA and OCR B-r2 seed status

### 2026-07-17T06:18:59.858Z · change · root

- Scope：Stop idle project-owned OCR model server after both reprocess workers had already exited
- Resources：`DMITPro2 inner bdfz workstation`、`curriculum-ocr-llama.service`
- Evidence：Before stop both OCR workers had MainPID 0; A exit 12 and B exit 75; llama alone used 11772493824 bytes RAM and 2574 MiB VRAM. After bounded stop unit is inactive/dead MainPID 0, no llama-server process, MemAvailable 14663229440 bytes and GPU memory 12 MiB
- Rollback：Run systemctl --user start curriculum-ocr-llama.service on inner bdfz, then verify exact binary/model/mmproj/flags, loopback health and runtime fingerprint before any OCR worker start
- Unresolved：B-r2 lineage code and seed-only transaction must pass local and remote verification before model or OCR worker restart

### 2026-07-17T06:35:37.437Z · verify · codex-production-qa

- Scope：production-post-release-api-browser-pulse-d1-read-only-qa
- Resources：`curriculum.bdfz.net`、`bdfz-curriculum-atlas`、`bdfz-curriculum-atlas-D1`、`pulse.bdfz.net`、`Playwright`、`/private/tmp/curriculum-production-qa`
- Evidence：PASS: health 200 v10 Git57487dc schemas3/2/1 five bindings; corpus196/16456/16456/6031/91; taxonomy12 facets 28 identities; browser 1440x1000 1280x720 390x844 full553 lineage214 hide-all0 Chinese143/60 no movement leak no overflow; API negative gates 401/403; D1 user counts 0/0/3/2/0 and canonical digest c4166f451f4b9529bf4221b56fb3017dc51aef7493a699553dc218287e42c430 unchanged; Pulse tracked worker_analytics; task browser sessions closed and CLI list empty, root final ps found no task daemon/profile
- Rollback：read-only-QA-no-rollback-required
- Unresolved：Cloudflare Turnstile discussion challenge emitted two third-party opaque console errors and five warnings but zero first-party console errors or page errors; graph observation data currently ends in 2020 while 2022 corpus documents and era rail remain present, pending later accepted OCR concept rebuild

</details>

<details><summary><code>curriculum-atlas-fixture-core-counts-20260716</code> · 4 events · 2026-07-17T02:19:20.193Z → 2026-07-17T02:20:36.984Z</summary>

Agents：`codex-release-tree-review`
Resources：`curriculum-atlas/tests/backend-integrity.test.mjs`、`curriculum-atlas/tests/page-publication-gate.test.mjs`、`curriculum-atlas focused Node test run`

### 2026-07-17T02:19:20.193Z · start · codex-release-tree-review

- Scope：Parent-authorized isolated fixture repair for exact corpus core-table release metadata; source ownership limited to two test files
- Resources：`curriculum-atlas/tests/backend-integrity.test.mjs`、`curriculum-atlas/tests/page-publication-gate.test.mjs`
- Evidence：Parent curriculum-atlas-full-release task explicitly delegated exclusive ownership; both files are untracked within that active release tree
- Rollback：Reverse only the inserted fixture constants and three metadata fields; no runtime or production resource is touched
- Unresolved：Need focused tests to prove existing route semantics

### 2026-07-17T02:20:36.771Z · change · codex-release-tree-review

- Scope：Added one exact 13-key zero-valued core-table count JSON fixture per test file and bound it to expected actual and live corpus release rows
- Resources：`curriculum-atlas/tests/backend-integrity.test.mjs`、`curriculum-atlas/tests/page-publication-gate.test.mjs`
- Evidence：Each corpus_import_releases mock now returns expected_core_counts_json actual_core_counts_json and live_core_counts_json from the same exact key set
- Rollback：Remove the two fixture constants and six row fields only
- Unresolved：none

### 2026-07-17T02:20:36.879Z · verify · codex-release-tree-review

- Scope：Verified the isolated fixture repair preserves all existing route and publication-gate assertions
- Resources：`curriculum-atlas focused Node test run`
- Evidence：node --test on the two owned files passed 36 of 36 tests; node syntax checks passed for both files
- Rollback：No remote rollback applies; source-only test fixture change
- Unresolved：none

### 2026-07-17T02:20:36.984Z · closeout · codex-release-tree-review

- Scope：Handed the two passing fixture files back to the parent full-release task
- Resources：`curriculum-atlas/tests/backend-integrity.test.mjs`、`curriculum-atlas/tests/page-publication-gate.test.mjs`
- Evidence：Focused tests pass and ownership remained limited to the two delegated files
- Rollback：Revert only the added constants and metadata fields if parent full-suite verification exposes incompatibility
- Unresolved：Parent must run the full suite before staging

</details>

<details><summary><code>curriculum-atlas-private-archive-upload-20260717</code> · 5 events · 2026-07-17T03:03:21.225Z → 2026-07-17T06:05:23.716Z</summary>

Agents：`/root/private_archive_upload`
Resources：`R2 bdfz-ops-backups curriculum-atlas/private-archive/v1/20260717T021000Z/`、`backups/curriculum-atlas/private-archive/20260717T021000Z`、`backups/curriculum-atlas/private-archive/20260717T021000Z/archive-index.json`、`remote-readback`、`remote-isolated-restore`、`upload-parts`、`manifests`

### 2026-07-17T03:03:21.225Z · start · /root/private_archive_upload

- Scope：Finish approved encrypted private archive upload and 100 percent remote readback under the governed curriculum archive prefix only; exclude source repo, runtime, D1, public R2 and OCR jobs
- Resources：`R2 bdfz-ops-backups curriculum-atlas/private-archive/v1/20260717T021000Z/`、`backups/curriculum-atlas/private-archive/20260717T021000Z`
- Evidence：Local final set is exactly 14 encrypted parts totaling 3304573169 bytes and every size and SHA-256 matches archive-index schema 2; action-log overlap is parent-delegated and disjoint from active release source/runtime work
- Rollback：Delete only the exact governed R2 prefix after explicit review; do not execute deletion; preserve all local parts and evidence
- Unresolved：Scoped credential mint, upload, full readback, decryption, manifest replay, final index upload and canonical report append remain pending

### 2026-07-17T03:30:47.479Z · change · /root/private_archive_upload

- Scope：Begin exact-key encrypted archive publication under the governed private prefix using API-minted temporary credentials
- Resources：`R2 bdfz-ops-backups curriculum-atlas/private-archive/v1/20260717T021000Z/`
- Evidence：Env-only rclone exact-object multipart probe completed and post-upload validation passed for 1 object totaling 35510950 bytes; prior rclone directory probe, AWS CLI transport and bounded curl single PUT committed no object
- Rollback：Delete only the exact governed R2 prefix after explicit review; do not execute deletion
- Unresolved：Thirteen final encrypted part objects, complete list and HEAD proof, full readback restore and index publication remain pending

### 2026-07-17T05:32:51.860Z · change · /root/private_archive_upload

- Scope：Publish exact governed encrypted part set under the private archive prefix
- Resources：`R2 bdfz-ops-backups curriculum-atlas/private-archive/v1/20260717T021000Z/`
- Evidence：Exactly 14 final encrypted part objects atomically uploaded with batch success totaling 3304573169 bytes; strict exact-key transport used at most two concurrent transfers; no upload failures and no index object published yet
- Rollback：Delete only the exact governed R2 prefix after explicit review; do not execute deletion; preserve all local archive evidence
- Unresolved：Complete exact list and HEAD proof, download all 14 objects, verify every size and SHA-256, restore both streams, replay manifests and publish final index last

### 2026-07-17T06:03:10.041Z · verify · /root/private_archive_upload

- Scope：Prove exact remote archive completeness and isolated restorability before final index publication
- Resources：`R2 bdfz-ops-backups curriculum-atlas/private-archive/v1/20260717T021000Z/`、`backups/curriculum-atlas/private-archive/20260717T021000Z/archive-index.json`、`remote-readback`、`remote-isolated-restore`
- Evidence：Exact 14-part list and all HEAD sizes passed; full GET verified 14 objects totaling 3304573169 bytes with every SHA-256 exact; encrypted streams matched raw 3000626763 bytes and evidence 303946406 bytes; isolated age zstd tar restores replayed raw 246 of 246 files and 3245326023 bytes plus evidence 81318 of 81318 files and 813926562 bytes with zero missing extra or problems; final index uploaded last and GET matched 8581 bytes SHA256 2ee9d8088dd89f77123c01da67916912f43c65c582c2ba6909fcb2904772bf2f; final exact prefix is 15 objects and 3304581750 bytes
- Rollback：Delete only the exact governed R2 prefix after explicit review; do not execute deletion; preserve local readback and isolated restore evidence
- Unresolved：Canonical report append awaits coordination with the parent production and OCR closeout; no archive verification defect remains

### 2026-07-17T06:05:23.716Z · closeout · /root/private_archive_upload

- Scope：Close verified encrypted private archive publication with governed local evidence retained and report handoff to parent
- Resources：`R2 bdfz-ops-backups curriculum-atlas/private-archive/v1/20260717T021000Z/`、`backups/curriculum-atlas/private-archive/20260717T021000Z/archive-index.json`、`upload-parts`、`remote-readback`、`remote-isolated-restore`、`manifests`
- Evidence：Final exact prefix is 15 objects and 3304581750 bytes; index GET is 8581 bytes SHA256 2ee9d8088dd89f77123c01da67916912f43c65c582c2ba6909fcb2904772bf2f; restored raw set is 246 of 246 files and 3245326023 bytes and OCR evidence is 81318 of 81318 files and 813926562 bytes with zero missing extra or problems; remote-readback contains exactly 15 files and 3304581750 bytes with zero partial or temp files; no browser session was opened and required dry-run found zero cliDaemon processes
- Rollback：Do not execute automatically; after explicit review delete only the exact R2 prefix curriculum-atlas/private-archive/v1/20260717T021000Z/; preserve governed local archive evidence and never broaden deletion
- Unresolved：No archive verification defect remains; canonical report section is handed to parent for conflict-free merge; retain raw sources long term and OCR evidence through publication plus at least 90 days; review local preflight rebuilt and superseded evidence only under a future explicit retention cleanup, with no deletion now

</details>

<details><summary><code>curriculum-chemistry-page84-adjudication-20260716</code> · 4 events · 2026-07-17T03:06:27.162Z → 2026-07-17T03:18:04.643Z</summary>

Agents：`codex-ocr-audit`
Resources：`curriculum-atlas:.cache/sources/local-compendia/chemistry.pdf`、`curriculum-atlas:.cache/ocr-witness/legacy-compendium-chemistry/images/page-084.png`、`curriculum-atlas:.cache/ocr-witness/legacy-compendium-chemistry/vision/page-084.json`、`/private/tmp/curriculum-chemistry-page84-adjudication`、`curriculum-atlas:.cache/paddlex`、`curriculum-atlas:.cache/ocr-production/legacy-compendium-chemistry/state.json`、`curriculum-atlas:.cache/ocr-supervisor/page-retries.json`、`curriculum-atlas:legacy-compendium-chemistry:84:paddle`

### 2026-07-17T03:06:27.162Z · start · codex-ocr-audit

- Scope：Bounded local-only adjudication of legacy-compendium-chemistry physical page 84 using retained source image, Apple Vision accurate and PP-Structure fallback; preserve citation/display false and existing quarantine unless the documented repair gate passes
- Resources：`curriculum-atlas:.cache/sources/local-compendia/chemistry.pdf`、`curriculum-atlas:.cache/ocr-witness/legacy-compendium-chemistry/images/page-084.png`、`curriculum-atlas:.cache/ocr-witness/legacy-compendium-chemistry/vision/page-084.json`、`/private/tmp/curriculum-chemistry-page84-adjudication`
- Evidence：Source SHA-256 equals queue identity; retained 240-DPI image is 1985x2820 with bound SHA-256; page retry ledger records five PEG-native 500 attempts and citation remains false
- Rollback：Remove only temporary adjudication artifacts; do not edit OCR state or retry ledger unless the existing validated repair tool accepts all identities
- Unresolved：Need run single-page independent fallback, inspect scan/text alignment, and determine whether existing repair tool can safely clear quarantine without bypassing whole-document or citation gates

### 2026-07-17T03:18:04.475Z · change · codex-ocr-audit

- Scope：Generated bounded local adjudication artifacts only for legacy-compendium-chemistry physical page 84; OCR state, retry ledger, publication data and remote lanes were not modified
- Resources：`/private/tmp/curriculum-chemistry-page84-adjudication`、`curriculum-atlas:.cache/paddlex`
- Evidence：PP-StructureV3 with PP-OCRv5 completed in 396.125 seconds from pinned cache; manifest SHA-256 80a7e78b19767c3492bf1e520ef1b6946b0f2f4fff16d4ee712d0d33b17a947e binds retained image SHA-256 4663963e6899fa6adcc0de601db4a555245e41d866aa7346b681a771f887b797; pinned MuPDF produced a 300-DPI visual adjudication render SHA-256 b535ef66ac16e83aa3a0b399af8743fb8cc6bbca5facb93b3beff1445e0e8fa2
- Rollback：Remove /private/tmp/curriculum-chemistry-page84-adjudication only
- Unresolved：Fallback contains bleed-through false text, omits visible content and agrees with Apple Vision on one scan-ambiguous character, so exact-text gate is not satisfied

### 2026-07-17T03:18:04.559Z · verify · codex-ocr-audit

- Scope：Verified the page-84 independent fallback against the retained image, Apple Vision witness, 300-DPI scan and current supervisor state
- Resources：`curriculum-atlas:.cache/ocr-production/legacy-compendium-chemistry/state.json`、`curriculum-atlas:.cache/ocr-supervisor/page-retries.json`、`curriculum-atlas:.cache/ocr-witness/legacy-compendium-chemistry/vision/page-084.json`
- Evidence：Source SHA-256 0ec72a59fab2e648f5bf5d41aab41a94b2303e30f6e4c8aae052bec2ee45c514 and image SHA-256 match bound identities; supervisor remains 6947 of 11847 complete with one quarantined page and zero citation-eligible pages; watchdog held at 2026-07-17T03:16:46Z; same-edition exact online witness was not established
- Rollback：No persistent OCR mutation occurred
- Unresolved：A secondary online analogue is from a different 1936 version and cannot resolve the 1941 scan; existing repair receiver requires a complete whole-document artifact rather than the local selected-pages 84 state

### 2026-07-17T03:18:04.643Z · closeout · codex-ocr-audit

- Scope：Closed bounded local page-84 adjudication fail-closed without clearing quarantine or resuming local drain
- Resources：`curriculum-atlas:legacy-compendium-chemistry:84:paddle`、`/private/tmp/curriculum-chemistry-page84-adjudication`
- Evidence：Retry ledger still records five attempts and quarantined true; OCR check exit code 2 reports PAGE_QUARANTINED only; git worktree remains main aligned with origin main and clean; no publication or citation state changed
- Rollback：Delete only the temporary adjudication directory if disk reclamation is desired
- Unresolved：Keep citation and display false; resolution needs a same-edition 1941 authoritative witness or human image adjudication plus a validated repair path, preferably complete remote chemistry output received through the existing whole-document gate

</details>

<details><summary><code>curriculum-atlas-staged-corpus-finalize-20260716</code> · 7 events · 2026-07-17T03:28:14.758Z → 2026-07-17T03:35:48.492Z</summary>

Agents：`codex-release-tree-review`
Resources：`curriculum-atlas/scripts/import-corpus.mjs`、`curriculum-atlas/tests/corpus-import-safety.test.mjs`

### 2026-07-17T03:28:14.758Z · start · codex-release-tree-review

- Scope：Parent-authorized surgical repair of local corpus importer finalization after preview D1 CPU-limit failure; ownership limited to scripts/import-corpus.mjs and tests/corpus-import-safety.test.mjs
- Resources：`curriculum-atlas/scripts/import-corpus.mjs`、`curriculum-atlas/tests/corpus-import-safety.test.mjs`
- Evidence：main and origin are clean and equal at 7bd37463a11a34f1951d04eeefa87c7d81028e62; parent release task retains live resource ownership; no live command is authorized here
- Rollback：Restore only the two task-owned files from Git or revert the eventual scoped commit; no remote rollback because this subtask performs no live writes
- Unresolved：Need replace monolithic finalize with bounded idempotent stages and prove intermediate failure never activates ready

### 2026-07-17T03:33:55.613Z · change · codex-release-tree-review

- Scope：Replaced the two FTS integrity anti-joins on UNINDEXED paragraph_id with trigger-bound rowid joins and added finalize-only exact-release recovery without chunk replay
- Resources：`curriculum-atlas/scripts/import-corpus.mjs`、`curriculum-atlas/tests/corpus-import-safety.test.mjs`
- Evidence：FTS schema writes rowid equal to paragraph id; recovery calls resume start with receipts preserved, then the unchanged fail-closed invariant gate and failure marker
- Rollback：Restore the two task-owned files to 7bd37463a11a34f1951d04eeefa87c7d81028e62; no live resource changed
- Unresolved：Parent full verification and live preview finalize remain outside this subtask

### 2026-07-17T03:33:55.640Z · verify · codex-release-tree-review

- Scope：Focused local safety verification of rowid finalization and failed-release recovery
- Resources：`curriculum-atlas/tests/corpus-import-safety.test.mjs`、`curriculum-atlas/scripts/import-corpus.mjs`
- Evidence：20 of 20 corpus import safety tests passed; node syntax check and git diff check passed; only the two authorized files are modified
- Rollback：No remote mutation; discard only the two scoped worktree changes if parent rejects the patch
- Unresolved：Full npm verification and live preview finalize are reserved for the parent release owner

### 2026-07-17T03:34:20.741Z · closeout · codex-release-tree-review

- Scope：Hand off the tested two-file importer repair to the parent full-release owner for full verification, commit, and controlled preview recovery
- Resources：`curriculum-atlas/scripts/import-corpus.mjs`、`curriculum-atlas/tests/corpus-import-safety.test.mjs`
- Evidence：Focused tests 20 of 20, syntax check, and diff check pass; root was notified that the shared-worktree patch is ready
- Rollback：Parent may restore only these two files to commit 7bd37463a11a34f1951d04eeefa87c7d81028e62; no D1 Worker R2 evidence or deploy mutation occurred
- Unresolved：Parent must run full verification, commit and push, then invoke finalize-only under its existing preview D1 backup and ownership before any R2 publication

### 2026-07-17T03:35:48.437Z · change · codex-release-tree-review

- Scope：Independent-review follow-up made FTS payload identity NULL-safe and prevented ambiguous client failure from downgrading an already activated release
- Resources：`curriculum-atlas/scripts/import-corpus.mjs`、`curriculum-atlas/tests/corpus-import-safety.test.mjs`
- Evidence：Failure SQL now updates only non-ready release state and conditions site_meta failed on the exact release actually being failed
- Rollback：Restore only the two task-owned files to 7bd37463a11a34f1951d04eeefa87c7d81028e62; no live resource changed
- Unresolved：Parent full verification and controlled preview finalize remain pending

### 2026-07-17T03:35:48.466Z · verify · codex-release-tree-review

- Scope：Reverified final two-file patch after ambiguity and NULL-safety hardening
- Resources：`curriculum-atlas/tests/corpus-import-safety.test.mjs`、`curriculum-atlas/scripts/import-corpus.mjs`
- Evidence：21 of 21 focused tests passed; syntax check and diff check passed; ready release downgrade regression covered
- Rollback：No remote mutation; parent may reject by restoring only the two scoped files
- Unresolved：Full npm verify and live preview recovery remain parent-owned

### 2026-07-17T03:35:48.492Z · closeout · codex-release-tree-review

- Scope：Final handoff of the reviewed importer recovery patch to the parent release owner
- Resources：`curriculum-atlas/scripts/import-corpus.mjs`、`curriculum-atlas/tests/corpus-import-safety.test.mjs`
- Evidence：Root notified with exact finalize-only command; focused tests 21 of 21 and static checks pass
- Rollback：Restore the two scoped files to 7bd37463a11a34f1951d04eeefa87c7d81028e62; no D1 Worker R2 evidence or deploy mutation occurred
- Unresolved：Parent must full verify commit push and perform the authorized preview finalize before R2 publication

</details>

<details><summary><code>curriculum-atlas-taxonomy-contract-20260717</code> · 4 events · 2026-07-17T03:52:36.862Z → 2026-07-17T04:08:26.895Z</summary>

Agents：`/root/taxonomy_contract_fix`
Resources：`curriculum-atlas taxonomy source`、`classification resolver`、`0007 migration`、`corpus builder`、`Worker API source`、`facet helper`、`focused tests`、`curriculum-atlas/migrations/0007_document_taxonomy_contract.sql`、`curriculum-atlas/src/index.ts`、`curriculum-atlas/src/retrieval.ts`、`curriculum-atlas/scripts/document-classification.mjs`、`curriculum-atlas/scripts/build-corpus.mjs`、`curriculum-atlas/public/app.js`、`curriculum-atlas/public/index.html`、`curriculum-atlas/data/release-assets-policy.json`、`curriculum-atlas/tests`、`curriculum-atlas local source and in-memory SQLite`、`curriculum-atlas working tree`

### 2026-07-17T03:52:36.862Z · start · /root/taxonomy_contract_fix

- Scope：Parent-delegated local-only repair of the public 12-facet taxonomy contract and persisted raw taxonomy semantics; production remains paused
- Resources：`curriculum-atlas taxonomy source`、`classification resolver`、`0007 migration`、`corpus builder`、`Worker API source`、`facet helper`、`focused tests`
- Evidence：Clean main equals origin at 6bacb44; preview smoke exposed one assessment_subject flattened to storage subject and public meta leaking exact identities; 196-record audit found 159 subject, 1 assessment_subject, 16 curriculum_course, 3 assessment_domain, 13 cross_cutting_framework and 4 source_collection records
- Rollback：Restore only task-owned local files to 6bacb44; no generated artifact, D1, R2, Worker, release evidence or commit is authorized
- Unresolved：Implement and test schema v2 persistence plus 12-facet meta contract without dropping raw labels or exact query identity

### 2026-07-17T04:08:26.725Z · change · /root/taxonomy_contract_fix

- Scope：curriculum-atlas taxonomy persistence and public API contract
- Resources：`curriculum-atlas/migrations/0007_document_taxonomy_contract.sql`、`curriculum-atlas/src/index.ts`、`curriculum-atlas/src/retrieval.ts`、`curriculum-atlas/scripts/document-classification.mjs`、`curriculum-atlas/scripts/build-corpus.mjs`、`curriculum-atlas/public/app.js`、`curriculum-atlas/public/index.html`、`curriculum-atlas/data/release-assets-policy.json`、`curriculum-atlas/tests`
- Evidence：Added schema v2 taxonomy kind plus twelve-facet contract; Worker v10 and cache v15; no generated release artifact or remote resource changed
- Rollback：Restore the scoped tracked files and remove the untracked 0007 migration before any deployment
- Unresolved：Governed release still requires generated corpus regeneration, preview migration/import/deploy, fresh evidence, and production promotion by release owner

### 2026-07-17T04:08:26.819Z · verify · /root/taxonomy_contract_fix

- Scope：local taxonomy contract verification
- Resources：`curriculum-atlas local source and in-memory SQLite`
- Evidence：npm build and TypeScript passed; full npm test 375 of 375 passed; legacy corpus plus migration 0007 backfill yielded 196 documents, 159 subjects, 1 assessment subject, 16 courses, 12 display facets, integrity_check ok
- Rollback：No remote mutation; local changes remain uncommitted
- Unresolved：No preview or production D1, R2, Worker, or browser verification performed in this subtask

### 2026-07-17T04:08:26.895Z · closeout · /root/taxonomy_contract_fix

- Scope：taxonomy contract handoff to release owner
- Resources：`curriculum-atlas working tree`
- Evidence：Public facets are exact twelve, query identities are true subjects only, Han is a separate assessment identity related to Chinese, course and scope records remain non-subject
- Rollback：No commit and no deployment; release owner can restore only listed files
- Unresolved：Regenerate corpus artifacts before reimport; collect new preview and production environment evidence instead of reusing historical receipts

</details>

<details><summary><code>curriculum-ocr-watchdog-reference-audit-20260716</code> · 3 events · 2026-07-17T03:55:25.375Z → 2026-07-17T03:57:15.823Z</summary>

Agents：`codex-ocr-watchdog-audit`
Resources：`curriculum-atlas/scripts/ocr-watchdog.mjs`、`curriculum-atlas/tests OCR watchdog coverage`、`curriculum-atlas/.cache/ocr-supervisor read-only evidence`、`curriculum-atlas/tests/ocr-supervisor-faults.test.mjs`、`LaunchAgent com.suen.curriculum-ocr-watchdog`、`curriculum-atlas watchdog source and focused tests`、`LaunchAgent read-only state`

### 2026-07-17T03:55:25.375Z · start · codex-ocr-watchdog-audit

- Scope：Audit reported OCR watchdog child-scope ReferenceError against current source runtime state and focused regression coverage without changing control state
- Resources：`curriculum-atlas/scripts/ocr-watchdog.mjs`、`curriculum-atlas/tests OCR watchdog coverage`、`curriculum-atlas/.cache/ocr-supervisor read-only evidence`
- Evidence：Preflight found unrelated taxonomy work only in scripts/build-corpus.mjs scripts/document-classification.mjs and migration 0007; watchdog source and tests are unmodified; stderr evidence predates current source
- Rollback：No runtime or OCR artifact mutation authorized; if a focused test is needed restore only that test file
- Unresolved：Confirm live PID state freshness source revision and whether existing regression coverage already proves the child lifetime fix

### 2026-07-17T03:57:15.723Z · verify · codex-ocr-watchdog-audit

- Scope：Verified that the reported watchdog ReferenceError is stale historical stderr and the deployed source already contains and tests the scope fix
- Resources：`curriculum-atlas/scripts/ocr-watchdog.mjs`、`curriculum-atlas/tests/ocr-supervisor-faults.test.mjs`、`LaunchAgent com.suen.curriculum-ocr-watchdog`
- Evidence：stderr mtime 2026-07-15T17:51:47-0700 predates repaired source mtime 19:17:47; b8344 is an ancestor of HEAD; LaunchAgent runs PID 974 with no exit; state advanced from 03:56:14Z to 03:56:53Z in held status; focused tests 26 of 26 and syntax check pass
- Rollback：No change to roll back
- Unresolved：No kickstart required; held and PAGE_QUARANTINED are intentional fail-closed state, while remote OCR continuation remains parent-owned

### 2026-07-17T03:57:15.823Z · closeout · codex-ocr-watchdog-audit

- Scope：Closed the OCR watchdog ReferenceError audit without source test runtime control or OCR artifact changes
- Resources：`curriculum-atlas watchdog source and focused tests`、`LaunchAgent read-only state`
- Evidence：Current source declares child outside try and guards finally; existing regression asserts let child and lifecycle listener ordering; scoped git diff is empty and diff check passes; PID 974 is live and state remains fresh
- Rollback：No rollback needed because no task-scoped file or service mutation occurred
- Unresolved：Do not restart or kickstart the healthy held watchdog for the stale log; archive or rotate stderr only in a separately authorized maintenance action if desired

</details>

<details><summary><code>curriculum-atlas-inner-ssh-recovery-audit-20260716</code> · 2 events · 2026-07-17T04:11:48.489Z → 2026-07-17T04:11:48.593Z</summary>

Agents：`inner_ssh_recovery_audit`
Resources：`DMITPro2 outer jump host`、`DMITPro2 inner bdfz workstation SSH endpoint`、`local SSH configuration`、`agent action log`

### 2026-07-17T04:11:48.489Z · verify · inner_ssh_recovery_audit

- Scope：Read-only SSH authentication-chain audit; no OCR, service, or remote file mutation
- Resources：`DMITPro2 outer jump host`、`DMITPro2 inner bdfz workstation SSH endpoint`、`local SSH configuration`
- Evidence：Outer loopback listener active; strict host-key checking passed; local end-to-end public-key authentication reached inner host as suen in BatchMode
- Rollback：No rollback required; no host, service, config, OCR, or data state changed
- Unresolved：None; reusable ProxyCommand must retain StrictHostKeyChecking=yes and the approved local identity path

### 2026-07-17T04:11:48.593Z · closeout · inner_ssh_recovery_audit

- Scope：Completed read-only recovery audit and handed off non-interactive SSH template
- Resources：`DMITPro2 outer jump host`、`DMITPro2 inner bdfz workstation SSH endpoint`、`agent action log`
- Evidence：Confirmed prior two-hop failure was identity-location mismatch; ProxyCommand keeps inner authentication on the Mac and succeeds without password prompting or agent forwarding
- Rollback：No rollback required; only append-only operational audit entries were added
- Unresolved：Do not weaken host-key checking; if host keys legitimately rotate, verify out-of-band before replacing known_hosts entries

</details>

<details><summary><code>curriculum-ocr-b-r2-lineage-implementation-20260717</code> · 1 events · 2026-07-17T05:56:10.360Z → 2026-07-17T05:56:10.360Z</summary>

Agents：`/root/ocr_b_r2_lineage_implementation`
Resources：`curriculum-atlas/scripts/lib/remote-ocr-local-snapshot.mjs`、`curriculum-atlas/scripts/ocr-pdf-paddle.py`、`curriculum-atlas/scripts/run-remote-ocr-offload.mjs`、`curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`curriculum-atlas/tests/remote-ocr-offload-runner.test.mjs`、`curriculum-atlas/tests/remote-ocr-offload-receiver.test.mjs`、`curriculum-atlas/tests/test_ocr_pdf_paddle.py`、`curriculum-atlas/tests/ocr-pdf-paddle-microbatch.test.mjs`、`curriculum-atlas/tests/remote-ocr-reprocess-monitor.test.mjs`、`curriculum-atlas/package.json`

### 2026-07-17T05:56:10.360Z · start · /root/ocr_b_r2_lineage_implementation

- Scope：Local-only implementation of hash-bound B-r2 seed lineage in isolated worktree; own only the ten delegated source test and package files; no remote OCR host or production resource
- Resources：`curriculum-atlas/scripts/lib/remote-ocr-local-snapshot.mjs`、`curriculum-atlas/scripts/ocr-pdf-paddle.py`、`curriculum-atlas/scripts/run-remote-ocr-offload.mjs`、`curriculum-atlas/scripts/receive-remote-ocr-offload.mjs`、`curriculum-atlas/tests/remote-ocr-offload-runner.test.mjs`、`curriculum-atlas/tests/remote-ocr-offload-receiver.test.mjs`、`curriculum-atlas/tests/test_ocr_pdf_paddle.py`、`curriculum-atlas/tests/ocr-pdf-paddle-microbatch.test.mjs`、`curriculum-atlas/tests/remote-ocr-reprocess-monitor.test.mjs`、`curriculum-atlas/package.json`
- Evidence：Main repo clean and equal to origin/main at 57487dc95481391cbcd40e0be0c92ee2d1ed8fdf; recent action log shows parent owns live release and private archive agent owns disjoint R2 prefix; no overlapping source owner
- Rollback：Delete isolated /private/tmp worktree and branch or revert only eventual scoped commit; no remote rollback because no deploy or remote call is authorized
- Unresolved：Implement audited seed contract and pass focused plus full local verification before commit

</details>

<details><summary><code>curriculum-atlas-ops-docs-release-refresh-20260717</code> · 2 events · 2026-07-17T06:12:16.772Z → 2026-07-17T06:24:15.539Z</summary>

Agents：`/root/ops_docs_release_refresh`
Resources：`curriculum-atlas/CHANGELOG.md`、`curriculum-atlas/docs/deployment.md`、`curriculum-atlas/docs/operations.md`、`curriculum-atlas/docs/ai-handoff.md`、`curriculum-atlas/docs/data-model.md`、`curriculum-atlas/scripts/build-project-operations-ledger.mjs`、`curriculum-atlas/tests/project-operations-ledger.test.mjs`、`curriculum-atlas/docs/project-operations-ledger.md`

### 2026-07-17T06:12:16.772Z · start · /root/ops_docs_release_refresh

- Scope：Refresh isolated-worktree release operations documentation and deterministic operations ledger for live v10 taxonomy corpus and R2 release; no production mutation
- Resources：`curriculum-atlas/CHANGELOG.md`、`curriculum-atlas/docs/deployment.md`、`curriculum-atlas/docs/operations.md`、`curriculum-atlas/docs/ai-handoff.md`、`curriculum-atlas/docs/data-model.md`、`curriculum-atlas/scripts/build-project-operations-ledger.mjs`、`curriculum-atlas/tests/project-operations-ledger.test.mjs`、`curriculum-atlas/docs/project-operations-ledger.md`
- Evidence：Main repo clean at 290755749a0257ed720e7b2d26aa6b972c60aebb; active release and OCR owners are disjoint from delegated files; work will occur only in a private tmp worktree
- Rollback：Delete isolated worktree and branch or revert only the eventual scoped commit; no Cloudflare D1 R2 Worker or OCR host changes authorized
- Unresolved：Production browser visual QA wording remains pending parent result and will not be claimed before handoff

### 2026-07-17T06:24:15.539Z · change · /root/ops_docs_release_refresh

- Scope：Refresh current v10 release operations documentation and make the deterministic ledger derive Worker migrations corpus and post-evidence R2 state from governed evidence
- Resources：`curriculum-atlas/CHANGELOG.md`、`curriculum-atlas/docs/deployment.md`、`curriculum-atlas/docs/operations.md`、`curriculum-atlas/docs/ai-handoff.md`、`curriculum-atlas/docs/data-model.md`、`curriculum-atlas/scripts/build-project-operations-ledger.mjs`、`curriculum-atlas/tests/project-operations-ledger.test.mjs`、`curriculum-atlas/docs/project-operations-ledger.md`
- Evidence：Removed stale current v7 v8 v9 D1-0004 and stable-key blockers; documented exact v10 Worker D1 corpus taxonomy R2 rollback and encrypted archive facts while keeping OCR at 6947 primary 7012 Vision zero accepted and B-r1 frozen 1259 of 3182; production visual remains gated on final owner event
- Rollback：Revert only the isolated branch commit or delete the temporary worktree; no production Cloudflare OCR or canonical report state changed
- Unresolved：Regenerate after final production browser D1 console and teardown verification event then run focused and repository checks before commit

</details>

## 发布与回滚硬规则

1. 先冻结 Git commit 与 generated asset hashes，再创建 release manifest；不从 dirty tree 直接部署。
2. 先备份/Time Travel，按 preview 顺序执行 migrations → 支持新 schema 的 Worker/Assets → corpus release → Git-bound environment evidence → R2 metadata pointer；每层完成 hash/count readback。
3. D1 corpus import 必须有 `in_progress`/`ready` marker；未 ready 时所有数据 API、AI 和段落讨论路径返回 503，不能暴露混合快照。
4. R2 不允许固定手写文件白名单；每个公开元数据对象必须由 release policy 枚举并在上传后核对 size/hash。
5. OCR source、primary、witness、audit、online same-edition、page gate、semantic gate 是不同层；任何一层缺失都不可进入引文。
6. 生产 Worker v10 与 D1 0007 是耦合回滚：只回 Worker v7 会因 schema 不匹配返回 503；仅在确认无后续用户写入后同时使用已记录 Worker version 与 D1 bookmark。
7. R2-only 回滚只改 `release/current.json`：首次 production bootstrap 可删除 pointer 恢复 v10 stable-key fallback；有 predecessor 的环境恢复其原始 pointer bytes。中断发布先检查远端 immutable objects/pointer，不得盲目重跑。
8. 每次修改都写 action log `start/change/verify/closeout`，然后重新生成本总账并检查未 closeout 列表。

## 重建命令

```bash
cd /Users/ylsuen/CF/curriculum-atlas
node scripts/build-project-operations-ledger.mjs
```

生成器只读取项目文件、Git 与 append-only action log，只覆盖本文件；不访问网络、不运行 OCR、不写 D1/R2、不部署。
