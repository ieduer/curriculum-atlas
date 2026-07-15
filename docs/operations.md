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

最近一次验证为 2026-07-15：生产 Worker `b91d1d29-6f10-49a3-ab40-e4f84af76256`，立即回滚锚点为 `a53c6316-dbee-4e50-a5c2-fabac0fc73ee`；预览 Worker 为 `fc0f5923-28e8-4be9-8238-13cc9a33da5b`，入口为 `https://bdfz-curriculum-atlas-preview.bdfz.workers.dev`，回滚锚点为 `cc6dec86-d6ec-489e-b4c6-7c0b54f31dcd`。生产与预览 `/api/health` 均返回 `2026.07.15-v7`、全局 schema 3、分类子 schema 1、196/196 完整分类：160 份学科资料、16 份课程资料、20 份范围/框架资料、0 未分类，五项绑定全真。本次未改 D1/R2 数据；D1 仍为 196 份资料、16,456 段、103 份可引文资料、0 条公开评论和 1 条在线核查，精确学科 API 仍有 29 行，`/api/compare?subject=英语` 返回 9 份版本文献和 2 条编辑洞见。

正式概念模型为 456 个概念观察点（449 个可引文、3 个图文复核但不可逐字引用、4 个 OCR 候选）、429 条非语义自动关系、7,589 个版本内出现记录和 5,008 条完整证据。核心 JSON 为 2,961,343 bytes、SHA-256 `1570c0c98d5e7fb04be4ea451d4f18c50847813e350918e04bd3a66f6ae509d1`；完整学术模型为 26,124,389 bytes、SHA-256 `9b1f63eb6963152dcac24233f71b0adc518386802dd497809e8e26f80ecd8733`；生产、预览与本地一致，build revision 为 `ab30d3e09c9cf6706b7a3957e97925f66354d869dd840e8e9218401935288577`，发布图记录 552 页 OCR 覆盖。完整学术模型只作按需研究资产，首屏不会下载。

学术身份与星图展示已分层：D1/API、taxonomy、stable ID、官方代码和版本证据保留 29 行精确学科名称；星图只显示 12 个组，即语文、数学、外语、思想政治与道德法治、历史、历史与社会、地理、科学类、技术、劳动、艺术、体育与健康。汉语不再是独立开关，外语语种、历代思想政治/道德法治名称、科学分科、信息/通用技术分别归组；`定向行走`、`美工` 等课程和课程方案/考试评价等范围实体仍不进入学科组。全局“全部隐藏”使用独立门，连无学科的学业质量/框架节点及其关系一起隐藏。生产 Playwright 在 1440×900 与 390×844 均确认 12 组、旧独立项 0 个、全部隐藏后 active=0、再点外语只恢复外语、移动弹层 12/12 可见、横向溢出 0、控制台 0 错误，底部统计说明已删除。56 项 Node 测试、TypeScript、概念校验、在线核查样本、Wrangler dry-run 和 `git diff --check` 均通过。

OCR 严格批界快照（2026-07-15 13:45:25 UTC）为 761/8,690 页质量完成、7,929 页待处理、0 失败，761 页主 OCR / Apple Vision 见证 / exact 页级审计三者完全对齐，错误 sidecar、缺失见证、过期审计和隔离均为 0，磁盘约 99.5 GiB。watchdog 在该完整批界完成一次精确 PID/cwd/lock 验证后的平滑重载，约 10 秒后启动数学卷 33–96 页；状态已连续刷新 `observing_active_owner`，心跳约 2 秒，3 路并发无降级。艺术劳动 1–4 页和生物 1–4 页的旧审计缺口已通过只读输入复核的 `audit_backfill` 补齐。

并发基准在同一组 5 个已人工核锚点页面上比较 `parallel=1/2/3/4`：四组均为 68/70（0.9714），`parallel=3` 输出与 `parallel=1` 五页逐字节一致，用时由 45.982 秒降至 35.061 秒（快 23.75%），`parallel=4` 反而回退至 46.389 秒，因此生产固定为 3 路并发、每槽 8,192 context、`vl_rec_max_concurrency=3`。随后英语卷与小学综合卷两个完整 64 页批次分别用时 783.252 秒和 844.918 秒，128/128 主 OCR、Vision 见证、exact 审计全部齐全且零失败；计入 2.586 秒交接后，端到端吞吐为 4.709 页/分钟，即 47.09 页/10 分钟。若该区间持续，剩余 8,057 页约需 28.52 小时，两个实测批次对应约 27.39–29.54 小时；内容复杂度会使 ETA 浮动。跨引擎质量基准保留在 `data/ocr-benchmark-results.json`，本轮并发选择和完整批次验收另存 `data/ocr-throughput-benchmark-results.json`，避免覆盖历史证据。OCR 页仍全部 `citation_allowed=false`，机器排空不替代逐页图像、独立识别和同版在线文本的编辑核查。

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
