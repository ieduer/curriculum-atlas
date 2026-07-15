# 运维与八点验证标准

## 1. Source of truth

代码与生成规则：`/Users/ylsuen/CF/curriculum-atlas`。官方目录与本地扫描库存只进入 `data/*.json` 和 `.cache/` 研究区；D1/R2 是部署产物，不反向覆盖来源。

## 2. Health probe

`GET /api/health` 必须为 200、`ok=true`、`schemaVersion=3`、`classificationSchemaVersion=1`，分类覆盖须为 196/196：160 份学科资料、16 份课程资料、20 份范围/框架资料、`unclassifiedDocuments=0`，且 D1、R2、APIS、User Center、Assets 五项绑定均为 true。分类表采用加法子 schema，不提升全局 schema；因此发布后仍可直接回滚到 v4 Worker，而无需为代码回滚同步恢复 D1。

## 3. Contract check

- `/api/meta`：文档、段落、可引文文档及在线核验数量与生成清单一致。
- `/api/search`：仅返回文档和段落双重白名单内容。
- 历史扫描详情：文档级保持 fail-closed，但已核验单项显示版次关系、证据 URL、图像/OCR 哈希与处理结论。
- `/api/source-manifest`：R2 对象存在并带 ETag。
- 未登录 AI 返回 401；无 Turnstile secret 的匿名讨论返回 503，不可 fail-open。

## 4. Deploy and forbidden actions

发布命令见 `docs/deployment.md`。禁止直接编辑 D1 生产文本、把扫描件整体放入公开 R2、用新版本覆盖历史措辞、绕过 `apis` 直连 Gemini、在共享枢纽脏工作树未核对时夹带部署。

## 5. Dependency regression

发布后检查：

- `my.bdfz.net/api/session` 的同源认证路径。
- `nav.bdfz.net/sites.json` 中 `curriculum.bdfz.net` 唯一。
- Companion URL 策略测试通过。
- Pulse 能把 Worker `bdfz-curriculum-atlas` 映射到 `curriculum.bdfz.net`。
- APIS health 可用，AI 回答引文不越界。

## 6. Backup and restore

D1 依赖 Time Travel；发布前记录书签。代码进入 Git，未公开 PDF 保留本地原文件与 SHA-256。R2 只保存可重建的 JSON 元数据。讨论是用户数据，任何重建都必须保留 `comments`、`comment_reports` 和审计表。

## 7. Rollback

Worker、D1、R2 和五个公共注册表面的回滚方法见 `docs/deployment.md`。语料增量导入使用 `ON CONFLICT ... DO UPDATE`，禁止使用会级联删除评论的 `INSERT OR REPLACE INTO documents`。

## 8. Last verified

每次发布在 canonical Cloudflare report 和 `agent_action_log.jsonl` 记录：时间、Worker 版本、D1 schema/counts、R2 ETag、API/浏览器证据、User Center 写入回查、Pulse 覆盖、回滚锚点与未解决风险。

最近一次验证为 2026-07-15：生产 Worker `7d1766b2-32be-4ce1-9528-f6c69bb2a092`，立即回滚锚点为 `b91d1d29-6f10-49a3-ab40-e4f84af76256`；预览 Worker 为 `c9d47854-1815-4218-a014-66429fbd3b2a`，入口为 `https://bdfz-curriculum-atlas-preview.bdfz.workers.dev`，立即回滚锚点为 `fc0f5923-28e8-4be9-8238-13cc9a33da5b`。生产与预览 `/api/health` 均返回 `2026.07.15-v7`、全局 schema 3、分类子 schema 1、196/196 完整分类：160 份学科资料、16 份课程资料、20 份范围/框架资料、0 未分类，五项绑定全真。本次只更新 Worker/Assets，未改 D1/R2；D1 仍为 196 份资料、16,456 段、103 份可引文资料、0 条公开评论和 1 条在线核查，精确学科 API 仍有 29 行，`/api/compare?subject=语文` 返回 10 份版本文献和 3 条编辑洞见。

正式概念模型为 560 个概念观察点（553 个可引文、3 个图文复核但不可逐字引用、4 个 OCR 候选）、475 条词面观察关系、7,836 个版本内出现记录和 5,235 条完整证据。核心 JSON 为 3,756,102 bytes、SHA-256 `c9510f653c75e9976fdb95ac8c7d0524dabd088466a3683ee10310b7c8f50dd5`；完整学术模型为 21,896,790 bytes、SHA-256 `c2cccb603ca8d13c6c2cb86ba80da53e14c8a81aa199c563d50c739ee29d8dd0`；生产、预览与本地一致，build revision 为 `028200e24fa87e835f0f8a9ba91aeae8d0e5edf9a668c3198e84b2c3deaf9436`，发布图记录 1,142 页主 OCR 覆盖。完整学术模型改为无损紧凑 JSON，保持全部字段同时低于 Cloudflare 单资产 25 MiB 限制，仍只作按需研究资产，首屏不会下载。

学术身份与星图展示已分层：D1/API、taxonomy、stable ID、官方代码和版本证据保留 29 行精确学科名称；星图竖列只显示 12 个组，不再显示冗余“全部学科”。普通点击隔离单科，再点唯一激活学科恢复全部，Shift 可多选。每个 episode 的 `visibility_facets`/`visibility_policy` 只允许直接受控学科或经审核课程关系进入单科视图；全 12 科隔离回归确认语文不再出现综合康复的“运动能力”，艺术等同名词也不跨课程语境泄漏。

新增语文 `概念深挖` 星图：76 个 edition-scoped 节点、3 个版本范围、14 个官方证据锚点和 82 条结构/经核关系。一级可进入语言文字运用、三维目标、核心素养、语文实践、18 个学习任务群和学业质量；继续展开 5 类语言活动、3 个历史目标维度、4 个核心素养维度、12 项课程目标、15 项学生能力、5 个质量等级。4 个学业质量表现轴明确显示“编辑推断·非官方表头”；20 项表格细目在视觉重组前继续 fail-closed。生产 Playwright 在 1280×720 与 390×844 均确认 12/12 学科可见、旧“全部学科”0 个、18 个任务群完整存在、横向溢出 0、控制台 0 错误。63 项 Node 测试、TypeScript、概念校验、在线核查样本、Wrangler dry-run 和 `git diff --check` 均通过。

OCR 覆盖审计新增本机缓存的教育部 2011/2022 义务教育标准 36 份、3,157 页；每份均核验 PDF 签名、页数、SHA-256 和无可用原生正文，且固定为 `ocr_required`、`citation_allowed=false`。队列由 50 份/8,690 页扩大为 86 份/11,847 页，语文 2011/2022 两版列为优先级 0。旧队列在完整 64 页批界进入 hold，经精确 PID/cwd/命令/锁核对后平滑释放并恢复 run，未中断 Paddle 页处理，也未重做已通过哈希与审计的页面。

OCR 严格快照（2026-07-15 15:23:42 UTC）为 1,228/11,847 页 exact 审计完成、10,619 页待完成质量闭环、0 失败；主 OCR 已完成 1,231 页，Apple Vision 见证 1,273 页，差值来自当前在途批次，完成页缺见证、错误 sidecar、过期审计、重试和隔离均为 0。1,228 个已审计页中 357 页待图像复核、11 页待空白确认、860 页 unresolved fail-closed、0 页自动引文放行。2011 年版义教语文已 83/83 完成且零失败；当前正在处理 2022 年版义教语文 65–109 页。watchdog 为 `observing_active_owner`，三路并发、llama health 与心跳正常，磁盘约 97.2 GiB。

并发基准在同一组 5 个已人工核锚点页面上比较 `parallel=1/2/3/4`：四组均为 68/70（0.9714），`parallel=3` 输出与 `parallel=1` 五页逐字节一致，用时由 45.982 秒降至 35.061 秒（快 23.75%），`parallel=4` 反而回退至 46.389 秒，因此生产固定为 3 路并发、每槽 8,192 context、`vl_rec_max_concurrency=3`。随后英语卷与小学综合卷两个完整 64 页批次分别用时 783.252 秒和 844.918 秒，128/128 主 OCR、Vision 见证、exact 审计全部齐全且零失败；计入 2.586 秒交接后，端到端吞吐为 4.709 页/分钟，即 47.09 页/10 分钟。按该实测吞吐，扩容后剩余 10,619 页约为 37.6 小时；扫描复杂度会使 ETA 浮动。跨引擎质量基准保留在 `data/ocr-benchmark-results.json`，本轮并发选择和完整批次验收另存 `data/ocr-throughput-benchmark-results.json`，避免覆盖历史证据。OCR 页仍全部 `citation_allowed=false`，机器排空不替代逐页图像、独立识别和同版在线文本的编辑核查。

OCR 长任务由 `scripts/ocr-supervisor.mjs` 监管；`npm run ocr:check` 提供机器健康码，`npm run ocr:status` 查看锁、心跳、磁盘、见证、审计、复核和概念图覆盖。退出码合同为：`0` 健康、`2` 退避/局部隔离、`10` 运行或页/见证失败、`11` 停滞、`12` 全局硬停止、`75` 正在运行且锁归属有效。`npm run ocr:recover` 是显式绕过非隔离退避的单页恢复探针；它绝不绕过 quarantine。

可见的 Codex automation `Curriculum OCR quality supervisor` 已暂停，其产生的 6 个历史任务已归档。后台改由本机 LaunchAgent `com.suen.curriculum-ocr-watchdog` 静默运行 `scripts/ocr-watchdog.mjs`，每 15 秒核对 drain PID、命令、cwd、锁和心跳；只有同一 owner 连续两次超过 180 秒无心跳才允许发信号，随后只做单页有界恢复。生产 fast path 是单例 64 页连续排空；Apple Vision 失败按 2、10、30 秒以新进程重试，缺失/过期审计只走 `audit_backfill`。低于 50 GiB 停止自动续跑，低于 25 GiB 硬停止；未知进程不清理，失败页不放行。单页/单文档隔离不会阻断其他合格任务；共享 runtime、模型校验和、磁盘才是全局阻断。

LaunchAgent 模板为 `ops/launchd/com.suen.curriculum-ocr-watchdog.plist`，当前安装在 `~/Library/LaunchAgents/`。`npm run ocr:watchdog:status` 查看 watchdog 自身状态，`npm run ocr:status` 查看严格队列状态；正常运行时前者应每 15 秒刷新 `observing_active_owner`，不能长期停在 `starting_drain`。回滚先以 exact PID/cwd/lock 确认 owner，再 `launchctl bootout gui/$(id -u)/com.suen.curriculum-ocr-watchdog`；不得用 broad `pkill`，也不得删除已经通过哈希和 exact audit 的页面。

Paddle 异常退出后仍重读 state，保留部分成功页，并为每个未完成页补齐 retry。Apple Vision sidecar 必须具备文档、页码、PDF 和图像 SHA；主 OCR 内容与 result 文件在进入审计前重新核对 state SHA。概念候选写入版本化 run 目录，只有 graph/quality revision 匹配且验证通过后才原子切换单一 manifest；保留当前和前一 last-good。保持已发布图和 Git 工作树不变；禁止自动部署、导入 D1、写 R2、提交或推送。只有人工证据复核和正式 `npm run concepts:build` 才能更新可发布图。

2026-07-15 故障恢复验证：`legacy-compendium-chinese` 1–4 页原 Apple Vision `nilError` 已分别通过 Vision、Paddle、页级审计恢复；10–20 页 11 份缺身份哈希的旧见证已重建。一次为切换并发参数而由精确 owner 发出的 SIGTERM 已保留中断记录，随后 16 页 p3 金丝雀及两个完整 64 页 p3 批次全部通过；当前错误 sidecar、完成页缺见证、Paddle 失败页、过期审计与隔离均为 0。15 页仍为 `unresolved_fail_closed`，属于内容质量门而非运行故障，不进入引文；后续连续排空的当前数字以上方带时间快照为准。

## 日常检查

- 每周：失败 OCR 队列、未核验冲突、匿名讨论待审核、AI 引文失败、Worker 错误率。
- 每月：官方目录与修订动态复查、来源 URL 可用性、R2 清单与本地 SHA 对账。
- 扫描件每次新增或更换：重算源 SHA、重新准备 OCR 队列，不继承旧页的通过状态。
- 自动监控只推进 OCR 与本地概念图候选更新；任何节点升级为可引用、进入正式关系或上线仍须人工证据门与发布验证。
- 日志只保留服务、版本、路径组、状态和错误类别；不写 cookies、session、原始研究问题或学生内容。
