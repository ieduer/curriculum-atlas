# 最初目标交付矩阵

> 本文件把立项时的十九节需求转换为可执行验收合同。它回答的不是“做过什么”，而是“什么证据齐备后才能称为完成”。历史过程见 [`project-operations-ledger.md`](project-operations-ledger.md)，实时运行标准见 [`operations.md`](operations.md)。

## 完成判定

本项目同时有两条完成轴，缺一不可：

1. **产品轴**：公共网站、检索、阅读、比较、AI、讨论、管理、统一身份、监控、备份和回滚在真实环境可用。
2. **学术证据轴**：文件身份、版本、页图、文本、段落、概念、关系和比较结论均能回到同版原文；不确定项保持 fail-closed。

因此，下列状态都不等于项目完成：PDF 已下载、OCR 页数已增长、D1 corpus 已上线、路由能打开、星图有节点、测试夹具能通过、空的数据合同已部署。

### 状态词

| 状态 | 含义 |
|---|---|
| `LIVE_VERIFIED` | 已在 production 产生带时间、版本和回滚锚点的真实验证证据 |
| `CANDIDATE_VERIFIED` | 本地候选已通过可重复测试，但尚未完成 preview/production 迁移与终验 |
| `EVIDENCE_BLOCKED` | 功能或结构存在，但内容未通过原图、同版文本、段落定位或编辑审核门 |
| `NOT_PROVED` | 尚无足够证据证明达到最初要求；不得从相邻功能推断完成 |

“整项完成”只允许在该项所有硬门为 `LIVE_VERIFIED` 后声明。表中出现多个状态时，以最弱状态为整项状态。

## 2026-07-22 真值快照

| 层 | 已证明状态 | 不得误读为 |
|---|---|---|
| Production v10 | 196 documents、16,456 paragraphs/FTS、6,031 page gates、91 chunks、12 display facets；API、三尺寸浏览器、D1 negative-write 与 Pulse 已终验 | 这些段落并非 11,000 余页历史扫描 OCR 全部通过审核 |
| OCR publication | accepted OCR documents/pages、display/citation promotion 均为 0 | OCR staging、Vision witness 或 audit 数量不是公开引文数量 |
| 本地整合候选 | 195 个规范作品；来源身份恢复提交已独立通过；2011 初中科学双扫描归并为一份作品 | 尚未替换 production v10 的 196 文档快照；其余本体、A2 与后台分支仍须独立审查后合并 |
| OCR 队列候选 | 名义 86 documents / 11,903 pages；扣除劳动课标完全相同别名后 85 unique artifacts / 11,835 pages；0 blocked documents | 入队不表示完成，更不表示可引用 |
| 概念图 | production 有 553 concept episodes、214 lineage、261 cross-subject edges；169 个公开本体节点主要属于语文 | 不是全学科、全历史、全层级精细本体；观察数据目前止于 2020 |
| 汇编篇目 | 61 个目录身份为候选，0 display / 0 citation / 0 semantic | 已识别目录不等于篇目正文、边界和版本身份已发布 |
| A2 远端 OCR | 同一 attempt 6 已耐久完成 1,568/3,182 页：4/8 卷完成、1 卷中断、3 卷 retry_wait、0 失败页；主机资源正常但服务仍按安全策略冻结，forward continuation 正在本地审查 | 不得另发授权、重置 attempt、覆盖 state，亦不得把耐久页数误报为可引用页数 |

任何后续状态变化必须更新本表的真值快照、`operations.md`、append-only action log 和 canonical Cloudflare report；不能只改 README 数字。

## 十九节需求逐项验收

| 原始章节 | 最初要求的可验收结果 | 当前证据 | 当前状态 | 退出硬门 |
|---|---|---|---|---|
| 1. 项目目标 | 教师能回答学习内容、知识/能力/素养、评价、课标与考试关系、理念、跨学科、版本增删和术语变义，并逐条回到原文 | 公共星图、资料/版本工作台、AI/讨论工作台已上线；但已核概念集中于语文，版本差异表尚无完整发布数据 | `EVIDENCE_BLOCKED` | 八类研究问题分别建立至少一个真实多版本垂直切片；每个结论可打开文件、版次、页码、段落、精确 span 与审核状态 |
| 2. 资料检索与完整性 | 按年代、阶段、学科、类型、机关、版本状态建立全国性清单；每份文件有完整元数据、来源、获取、解析和复核状态 | 候选有 195 个规范作品、来源主账、资产处置、Downloads 回执和缺口记录；仍有 metadata-only、blocked、derived lineage 与历史覆盖缺口 | `CANDIDATE_VERIFIED` + `EVIDENCE_BLOCKED` | 对每个年代×阶段×学科×文件类型覆盖单元给出分母、已得、缺失与理由；全部链接重新访问；无身份重复或伪版本 |
| 3. 数据结构与版本关系 | 统一建模文件、版本、目标、内容、任务、要求、评价、质量、术语、关系、差异、段落、评论和 AI 引文；版本关系不能只按年份 | taxonomy、edition、work、occurrence、evidence、ontology、discussion 和 AI citation 合同已存在；跨版本差异与全科 lineage 数据仍不完整 | `CANDIDATE_VERIFIED` + `EVIDENCE_BLOCKED` | 每个学科有无环、可解释的继承/修订/替代/补充/评价对应谱系；所有关系具两端同版证据和编辑审核 |
| 4. 网站信息架构 | 首页/总体演变/学科/最新版本/比较/跨学科/术语/理念/讨论形成研究系统，不是下载目录 | 已按后续产品决定合并为主星图、版本与资料、教师研究三个主要工作面；深层概念可在图内探索 | `LIVE_VERIFIED` + `EVIDENCE_BLOCKED` | 每个原始任务均能从合并后的入口完成；所有 12 display facets 有符合学科逻辑的深层结构，不以同一浅模板冒充 |
| 5. AI 多轮对话 | 只基于站内检索，显示文件/版本/章节/片段/链接/回答类型，支持多轮比较并记录模型、检索和引文 | APIS、D1 retrieval、句级引文验证、审计日志与 fail-closed 回答已实现；可用证据范围受当前 publication gate 限制 | `LIVE_VERIFIED` + `EVIDENCE_BLOCKED` | 用真实教师问题覆盖查询、双版、多版、跨学科、术语、评价、首次出现和研究提纲；每句引文精确回跳，注入测试与权限测试通过 |
| 6. 检索与阅读 | 全文和高级筛选正确；结果有上下文；阅读器支持目录、锚点、引用、高亮、术语、版本、评论、AI、移动端 | v10 有 16,456 可检索段落和分页/锚点 API；历史扫描、汇编篇目和最新版本结构化全文尚未全量开放 | `LIVE_VERIFIED` + `EVIDENCE_BLOCKED` | 对每类文件运行金标检索集；所有公开结果通过文档、页、段落、篇目身份门；最新版本网页阅读与 PDF 对页抽检通过 |
| 7. 可视化 | 时间轴、版本树、网络/矩阵/趋势等服务于理解；每个点可显示计算规则、文件和原文 | 概念星图、谱系/跨学科边、年代轨与证据 inspector 已上线；部分关系仍是 observation/research lead，不是已核历史结论 | `LIVE_VERIFIED` + `EVIDENCE_BLOCKED` | 每种视觉编码都有数据定义；节点大小/位置/连线非随机；全量抽样点击可到达证据；无证据的推断不进入已验证层 |
| 8. 前端视觉与交互 | 研究并复用 hp/qx 实现；宇宙为主视线；长文稳定；动画可关；低性能、移动、平板可用 | 全屏宇宙、双侧轨道、底部工作台、单学科自适应、hide-all、移动布局和 reduced-motion 合同已实现；production 三尺寸通过 | `LIVE_VERIFIED` | 新 release 重跑 Chrome/Safari/Firefox/Edge、键盘、reduced-motion、低性能与真机；第一方 console/page error 为 0 |
| 9. 技术架构 | Cloudflare 组件按规模选型；前端/API/数据/文件/搜索/向量/评论/身份边界清楚；服务端持久化与备份 | Worker+Assets、D1、R2、APIS、USER_CENTER 已上线；fenced release v2、0008/0009 与 compendium schema 仍是本地候选 | `LIVE_VERIFIED` + `CANDIDATE_VERIFIED` | preview 完成 dual-schema bridge、迁移、D1/R2 协调激活和回滚演练，再以相同工件发布 production |
| 10. 统一登录与站点关系 | 接入 my、Nav、Portal、Companion、Pulse；区分教师/学生/管理员；跨站依赖受控 | User Center、Nav、Portal、Companion 源码、Pulse 已登记并验证；Companion 新 APK 未经真实 Android 设备验收 | `LIVE_VERIFIED` + `NOT_PROVED` | authenticated/anonymous/admin 权限矩阵逐路由验证；真实设备 App 登录、回跳、讨论和 AI 验收；五个登记面与 Pulse live meta/range 一致 |
| 11. 内容处理流程 | 原件、哈希、OCR、目录/章节、锚点、分类、概念/评价、差异、关系、抽检、发布和更新日志分层且可持续 | 原件/清洗/结构化/分析分层、哈希、OCR supervisor、Vision、在线核对、page/semantic gates 和私有备份均已建立 | `CANDIDATE_VERIFIED` + `EVIDENCE_BLOCKED` | 当前 85 个唯一 OCR 实体全部形成整卷 receipt；逐页三证和编辑裁决完成；重建 corpus/FTS/graph 可重复且零越权发布 |
| 12. 编辑与审核后台 | 文件、元数据、章节、段落、术语、关系、AI、评论、权限、导入导出、索引和日志均可审计管理 | 有受保护的管理/审核 API、评论举报与内容审计数据结构；未证明存在覆盖全部原始功能的完整后台 UI 和真实管理员验收 | `NOT_PROVED` | 建立后台功能清单与角色矩阵；每个写操作保留 before/after、操作者和时间；真实 admin/non-admin 端到端测试通过 |
| 13. GitHub 公开仓库 | 公开源码、架构、开发、env、数据、导入、部署、测试、来源、版权、安全、贡献、日志、运维和接手文档齐备且无秘密 | `ieduer/curriculum-atlas` 已公开；本地候选比公开主线超前；gitleaks 当前候选无发现 | `LIVE_VERIFIED` + `CANDIDATE_VERIFIED` | 当前候选经独立审查后推送；GitHub HEAD 与将部署的 Assets Git 完全一致；公开仓库重新扫描无秘密和受限全文 |
| 14. 域名与部署 | preview 先行；DNS/HTTPS/cache/headers/CORS/CSP/rate/Turnstile/log/monitor/backup/rollback/SEO 完整 | `curriculum.bdfz.net` v10 正常；D1/R2/Worker、备份与 rollback 锚点已记录；候选 v13 尚未 preview/production | `LIVE_VERIFIED` + `CANDIDATE_VERIFIED` | 使用 exact clean HEAD 在 preview 执行完整发布手册和回滚演练，签发 acceptance receipt 后再 production；重跑 sitemap/robots/OG/headers |
| 15. 安全与隐私 | 匿名、令牌、后台、AI 滥用/注入、污染、上传、XSS/CSRF/SQLi、CORS、垃圾、限流、日志和密钥均受控 | CSP/CORS/Origin、Turnstile、HMAC 限流、参数化 D1、APIS/USER_CENTER 边界和 gitleaks 测试存在；新候选尚未 live 安全回归 | `LIVE_VERIFIED` + `CANDIDATE_VERIFIED` | 对真实 preview 做身份/权限/Origin/注入/污染/速率/日志脱敏测试；匿名数据不可反查；无 leaf Gemini secret |
| 16. 无障碍与兼容性 | 桌面/手机/平板、四浏览器、键盘、读屏、对比度、文字替代、动画关闭、弱网和 PDF/网页阅读可用 | responsive、移动工作台、reduced-motion 和文字回退有实现；production 三尺寸已过，但四浏览器、读屏和弱网全套证据不足 | `NOT_PROVED` | 建立 WCAG 抽检与浏览器矩阵；键盘焦点、读屏名称、对比度、Canvas 文字替代、弱网和长文稳定性全部留存证据 |
| 17. 核查标准 | 资料、数据、功能、AI、性能、部署/运维逐项实测，不以“页面能开”替代 | 项目已有 1,000 余项本地合同测试、live API/browser/D1/Pulse 事件和八点验证标准 | `CANDIDATE_VERIFIED` | 本文件全部十九项变成 `LIVE_VERIFIED`；任何 skip、blocked、待核或旧 release 数字均有明确处置，不允许整体“完成” |
| 18. 本机运维手册 | 真实记录资源、变量、schema、导入、更新、索引、AI、身份、评论、备份、部署、回滚、日志、故障、依赖和接手 | operations、deployment、OCR、资产、备份、AI handoff 与可重建总账已覆盖主要运行链 | `LIVE_VERIFIED` + `CANDIDATE_VERIFIED` | 每次 release 用手册在干净环境完成 bootstrap、部署、回滚和恢复；资源索引/canonical report 与 live state 一致 |
| 19. 实施要求 | 先审现状再架构；按资料→模型→原型→MVP→学科→AI/讨论→全面测试→正式部署；缺口不补造 | MVP 与基础设施已上线，后续按 fail-closed 证据治理推进；但全 OCR、全科语义加工和最终验收仍在进行 | `EVIDENCE_BLOCKED` | 完成下述关键路径并留下每一阶段不可变 receipt；最后一次 production 验证后才关闭项目目标 |

## 当前关键路径

按依赖顺序推进，不能用后一步绕过前一步：

1. **冻结唯一整合候选**：只把独立审查通过的来源、本体、OCR 续跑、学术证据与后台提交合入 `codex/curriculum-final-integration-20260722`；所有生成工件统一在组件收口后再生；保持 production v10 不变。
2. **安全续跑 A2**：只允许同一已存在 attempt 6、同一输出 inode、同一 authority/grant 的 forward continuation；先过 Linux/真实边界 dry-run，再恢复一个 canary 并连续观察。
3. **完成唯一 OCR 实体**：收齐整卷页集、state、日志、runtime/model/Paddle cache 身份和 receiver receipt；失败页隔离但不能丢失。
4. **完成逐页三证**：页图与 primary/Vision/audit 对齐；用同文同版在线文本核对；表格、罕见字符、页眉页脚和版本冲突走专门规则；人工签审后才写 page publication。
5. **深加工学术数据**：先以语文 2017→2020 垂直切片证明 exact-span 版本比较，再按 12 facets 建立学科特有目标—内容—能力/素养—任务—评价—学业质量多层本体。
6. **发布比较与关系**：差异、理念、术语变义、首次出现和跨学科关系必须绑定两端证据；覆盖不完整时禁止负面历史断言。
7. **Preview 一体发布**：同一 clean Git snapshot 完成 Worker bridge、0008/0009、corpus、graph、R2 和 D1/R2 coordinated activation；不允许拼接不同批次。
8. **原始任务端到端验收**：用教师问题验证搜索、阅读、比较、概念下钻、AI、讨论、后台、权限、移动、无障碍和性能；修复后重跑。
9. **Production 与运维闭环**：发布相同受审工件，核对五个注册面与 Pulse，完成 D1/R2 readback、浏览器终验、备份恢复和回滚证据，更新 canonical report 与本文件。

## 每次声称进度前的最小检查

```bash
npm run assets:audit
npm run page-evidence:validate
npm run compendium:boundaries:validate
npm run concepts:validate
npm run ontology:release:validate
npm run check
npm test
npm run test:python
```

这些命令只证明当前 Git 候选的合同，不证明 Cloudflare 已部署，也不证明 OCR/本体内容已获编辑接受。Preview/production 的完成证据必须另外包含 exact Git SHA、Worker deployment/version、D1 migration 与 corpus readback、R2 pointer/manifest/object readback、API/浏览器/依赖回归以及回滚锚点。

## 最终关闭条件

只有同时满足以下条件，才可把“继续推进直至全部上线”标为完成：

- 十九项均为 `LIVE_VERIFIED`，不存在未解释的 `EVIDENCE_BLOCKED` 或 `NOT_PROVED`；
- 所有公开事实、差异、概念和关系都能回跳到同版原文证据，未知项显式展示为未知；
- OCR、在线核对和编辑签审分层可审计，accepted 数量与 D1/R2/health/前端完全一致；
- preview 与 production 使用同一受审工件，GitHub HEAD、Assets Git、Worker、D1 corpus 和 R2 release 一致；
- AI、讨论、统一身份、后台权限、匿名隐私、无障碍、移动端与四浏览器通过真实环境验收；
- 备份已真实恢复，回滚已演练，运维手册、action log、项目总账和 canonical report 与 live state 一致。
