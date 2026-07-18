# 运维与八点验证标准

> 完整历史、Git 时间线、append-only 事件、回滚与未决项见 [`project-operations-ledger.md`](project-operations-ledger.md)。总账由 `npm run ops:ledger` 重建；本文件只给当前运行标准和最近一次已证明状态。

## 当前检查点（2026-07-17）

- 两端 D1 已应用 `0001`–`0007`；Worker 为 `2026.07.16-v10`，health 合同为 schema 3 / taxonomy 2 / page publication 1。
- Corpus `corpus-358471fcce862b2f0ae446fc` 在 preview 与 production 均为 `ready`：196 documents、16,456 paragraphs、16,456 FTS rows、6,031 page gates、16,456 displayed paragraphs、0 accepted OCR documents、91/91 chunks。
- Taxonomy 为 159 subject、1 assessment subject、16 curriculum course、20 scope；公开 12 个 display facets，普通学科 API 仅接受 28 个 exact query identities。
- Production Worker version `28c7e6d4-1638-42bc-b371-bd8d24210b93`，deployment `baa8a92f-ccc8-4972-b0ad-6d67876cdc84`，Assets Git `57487dc95481391cbcd40e0be0c92ee2d1ed8fdf`。
- Preview Worker version `2d107d38-cf31-49b6-82b1-20b32a32e824`，deployment `32b91e16-302a-4672-b55d-4e73bcedf54a`，Assets Git `40cb114e410e5f2afc886732eb146707edf8477b`。
- Production R2 current 为 `release-9cb02f77c06ee0535e7981a22b312373`；preview 为 `release-841a528f0086ce69f2f7a6f2d07c0999`。
- 环境证据提交为 `290755749a0257ed720e7b2d26aa6b972c60aebb`；完整本地发布链通过 380/380 tests。
- Production 只读终验事件 `2026-07-17T06:35:37.437Z`：三尺寸浏览器、API negative-write、D1 前后摘要与 Pulse 均通过；完整图 553/214/261、全隐藏 0/0、语文 143/60、运动能力泄漏 0，Pulse 425 requests / 0 errors。
- OCR 仍未完成或上线：本机 primary/audit 6,947/11,847、Vision 7,012、accepted display/citation 0；B-r1 冻结在 1,259/3,182。

## 1. Source of truth

代码、schema、生成规则与公开元数据来源：`/Users/ylsuen/CF/curriculum-atlas`。本机原 PDF、`data/ocr-queue.json`、OCR state、Vision witness、exact audit、在线同版核验和人工裁决是 OCR 接入权威；D1/R2 是可重建的部署产物，不能反向覆盖来源。

`data/release-environment-evidence.json` 绑定采集时的 Worker、D1、corpus 与 Assets；它不是会随 R2 pointer 自动更新的远端数据库。Evidence 之后的 R2 激活必须由 append-only action-log 的 pointer/manifest/object readback 证明，并明确标记观测时间。

DMITPro2 inner workstation 的 partial14 output 只属于隔离 staging。B-r1 的已有 state、attempt 和 page artifacts 不得在改变并发/idle/runtime identity 后直接复制为 B-r2；必须先实现并测试 hash-bound seed lineage，生成 predecessor receipt，再验签每个复用 page hash 和 attempt ledger。

## 2. Health probe

`GET /api/health` 必须返回 200、`ok=true`，并满足：

- `version=2026.07.16-v10`；
- `schemaVersion=3`、`classificationSchemaVersion=2`、`pagePublicationSchemaVersion=1`；
- classifications 为 196/196：159 subject、1 assessment subject、16 course、20 scope、0 unclassified；
- 12 display facets、28 exact subject query identities；
- D1、R2、APIS、User Center、Assets 五项 binding 为 true；
- current corpus 为 `ready`，expected/actual/live 的 documents、paragraphs、FTS、page gates、displayed、accepted OCR 与 chunk receipts 精确一致。

任一 corpus drift 必须返回 503。`/api/source-manifest` 若看到 current pointer，必须核验 pointer、versioned manifest 和目标 ingest object；pointer 存在但损坏时不能回退 stable key。

## 3. Contract check

- `/api/meta`：12 facets、28 ordinary subject query identities、1 个与语文 facet 相关但不进入普通 subject query 的 `汉语` assessment identity、16 courses。
- `/api/documents?limit=200`：总数 196；`subject=汉语` 必须 400；普通语文学科查询不得混入汉语考试资料。
- 技术课程保持 `curriculum_course` 且 `display_facet=null`；课程、评价领域、资料汇编与跨领域框架不得伪装成学科。
- `/api/search` 和 AI retrieval 只返回文档/段落双重白名单内容；未登录 AI 401，非法 Origin 讨论写入 403，无 secret 不可 fail open。
- `/api/compare?subject=语文`、资料 manifest、AI citations 的 taxonomy kind/facet 必须与 D1 身份一致。
- `release/current.json`、release manifest、17 个 versioned objects 与本地来源必须逐字节匹配。

Production R2 最近一次独立读回：

- pointer 388 bytes，SHA-256 `5142166d000fbf82e6d0a9d135a5340ba3c9d77f3bed803967ad565ff8c2133a`；
- manifest 107,777 bytes，SHA-256 `a6a15ea83cc58b1b84f5587a110c0fddeb414f24c77ff534507ea96868c03964`；
- 17/17 unique release objects 共 546,648 bytes，manifest / remote GET / local source 三方一致；
- `/api/source-manifest` 55,183 bytes，SHA-256 `0f0fda279b10ef40011ea28477deb528ed5d45b7478dfd93a8b7bf6d0b1cb16e`。

## 4. Deploy and forbidden actions

标准流程见 [`deployment.md`](deployment.md)：冻结与回滚锚点 → migrations → compatible Worker → exact corpus import → environment evidence commit/push → full verify → versioned R2 pointer → API/browser/dependency QA。

禁止：

- dirty-tree 或 stale evidence 发布；
- 在旧 Worker 上导入新 schema/corpus，或在 corpus 非 ready 时开放业务 API；
- corpus 中断后盲目重放 chunk；
- R2 中断后覆盖 immutable objects 或盲目重跑 publisher；
- 绕过 `apis` 直连 Gemini，或绕过 User Center 新建叶项目账户；
- 把原 PDF、完整受版权约束 OCR、secret、cookie、session 或用户内容放入公开 R2/Git/报告；
- 把远端 OCR staging、Vision 页数或机器排空写成 display/citation accepted。

## 5. Dependency regression

发布后检查：

- `my.bdfz.net/site-auth.js` 与 anonymous session contract；
- `nav.bdfz.net/sites.json` 中 `curriculum.bdfz.net` 唯一；
- User Center、portal、Companion 与 Pulse 源码注册仍存在；
- `apis.bdfz.net` health 正常，AI 回答不越引文闸门；
- Pulse `/api/meta` 与 `/api/range` 包含 curriculum；
- desktop/mobile 星图：全隐藏为零关系、单学科自动适配、语文不出现“运动能力”、12 facets 无“全部学科”、概念深挖/资料版本/AI讨论共用工作台、无 horizontal overflow；
- 浏览器会话关闭，并运行 Playwright orphan dry-run。

视觉结论必须来自带时间的 append-only `verify` 事件。当前 production 事件 `2026-07-17T06:35:37.437Z` 已证明：1440×1000、1280×720、390×844 无横向溢出；完整星图 553 nodes / 214 lineage / 261 cross-subject，全隐藏 0/0，语文 143/60 且运动能力泄漏 0；桌面与移动单科缩放 0.864→1.32、0.20→0.568；深链接、刷新、工作台、拖拽和缩放通过。未来 release 仍需新事件，不能沿用本次结果。

同一事件证明 API 写闸门为 401/403；D1 验收前后 comments / reports / rate limits / AI citation logs / content audit logs 为 0/0/3/2/0，canonical digest 均为 `c4166f451f4b9529bf4221b56fb3017dc51aef7493a699553dc218287e42c430`；Pulse 为 425 requests / 0 errors。第一方 console/page errors 为 0，Turnstile 仅有 2 个第三方 opaque errors / 5 个 warnings。

## 6. Backup and restore

D1 使用 Time Travel；发布前保存 bookmark 和用户数据基线。Production v10 prechange bookmark：`0000002b-00002585-000050ab-8645885d977dc9bf5678e6cdf12b084f`。代码进入 Git；原 PDF 与 OCR evidence 长期保留，不以 D1/R2 替代。

私有加密档案索引：`backups/curriculum-atlas/private-archive/20260717T021000Z/archive-index.json`。远端精确前缀包含 14 个 encrypted parts 与最后写入的 index，共 15 objects / 3,304,581,750 bytes；全量 GET、逐 part hash、decrypt、decompress 与 raw 246/246、evidence 81,318/81,318 manifest replay 均零缺失、零额外、零问题。密钥不进入项目文件或日志。

讨论、举报、限流、AI citation log 与内容审计是用户/运维数据，corpus rebuild 不得清空。任何 D1 Time Travel 恢复前必须确认 bookmark 之后是否出现合法写入。

## 7. Rollback

Production Worker v7 `7d1766b2-32be-4ce1-9528-f6c69bb2a092` 与 D1 prechange bookmark 是耦合回滚锚点：v7 不兼容 taxonomy schema 2，单独回 Worker 会返回 503。只有 forward repair 失败且确认无后续合法用户写入时，才同时回 D1 + Worker，并完成全套 API/browser regression。

R2-only 回滚不需要回 D1/Worker：

- production 首次 bootstrap：删除且只删除 `release/current.json`，使 v10 回到已验证 stable-key fallback；
- preview：恢复已备份 predecessor pointer bytes，指回 `release-b1c8c31d00e0016ad885ae5c9e92cad1`；
- 不删除任何 immutable release objects；恢复后 GET pointer、manifest 与 ingest object 核对 hash/bytes。

Publisher 中断后先读取远端 pointer/manifest/object set。Pointer 未切换时旧 release 仍在线，已上传对象可安全保持未引用；pointer 已切换时先完成 readback。两种情况都不得盲目重跑。

## 8. Last verified

Release evidence 观测于 2026-07-17，Git evidence commit `290755749a0257ed720e7b2d26aa6b972c60aebb`；两端 health 200、migrations 0001–0007、corpus ready，production/preview Worker、deployment 与 Assets Git 见本文检查点。

Production R2 post-evidence readback 已通过，精确 pointer/manifest/object/source-manifest 数字见 §3。Preview 与 production 的 API、desktop/mobile Canvas、taxonomy isolation 和依赖面均完成独立验证；production 权威事件为 `2026-07-17T06:35:37.437Z`。任务命名浏览器已关闭、CLI list 为空，root process 检查无任务 `cliDaemon.js`/profile、仅有 App-owned MCP；orphan dry-run 因平台 usage limit 拒绝提权且未绕过，不能写成 dry-run 已通过。

OCR 最近状态仍为本机 6,947 primary/audit、7,012 Vision、0 accepted；一页 chemistry quarantine 保持 fail-closed。概念 observation 数据止于 2020；2022 corpus documents 与年代轨存在，但只有 accepted OCR、版本核对和概念重建完成后才能加入 2022 概念观察。Remote B-r1 在连续低内存门后受控停止于 1,259/3,182，0 failed、0 quarantine、MainPID 0、NRestarts 0；现有页哈希与 attempts 必须保留。Hash-bound B-r2 seed lineage 尚未通过实现/测试/远端 predecessor receipt 三重门前，不得复制或启动新配置。

## OCR 日常运维

- `npm run ocr:watchdog:status`：看 watchdog control、owner 与 heartbeat；
- `npm run ocr:status`：看 11,847 页队列、primary、Vision、audit、review、quarantine 与 accepted；
- `npm run ocr:check`：机器可判定健康码；
- `npm run ocr:recover`：仅用于明确的非 quarantine 单页恢复，不绕过证据门。

远端健康不能只看 systemd active：必须核对 run identity、source/runner/OCR/model/mmproj/runtime hashes、loopback llama、status sidecar、逐卷 state/pages 与 memory/thermal gate。配置变化使用新 output root；复用旧完成页只能经 hash-bound seed lineage。A/B 不并行争用超出已验证的 host 并发，低内存门命中立即受控停止并保留状态。

机器 OCR 完成后仍须在 Mac 从原 PDF 重渲染 240 DPI 页图，记录图像 hash，完成 blind Apple Vision、exact audit、目录/篇目定位、同版官方或学术在线文本核对、version-match attestation 和必要人工裁决。任一层缺失，`display_allowed` / `citation_allowed` / `semantic_relation_allowed` 保持 false。

## 日常检查

- 每周：OCR failure/quarantine、未核验冲突、匿名讨论、AI 引文失败、Worker 错误率；
- 每月：官方修订动态、来源 URL、D1 corpus counts、R2 pointer/manifest/object 与本地 hash 对账；
- 每次新增/更换扫描：重算源 SHA，重新入队，不继承旧页通过状态；
- 每次发布：action log `start/change/verify/closeout`、canonical report、operations ledger、rollback anchor、Playwright cleanup 一并收口。
