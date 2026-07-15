# 运维与八点验证标准

## 1. Source of truth

代码与生成规则：`/Users/ylsuen/CF/curriculum-atlas`。官方目录与本地扫描库存只进入 `data/*.json` 和 `.cache/` 研究区；D1/R2 是部署产物，不反向覆盖来源。

## 2. Health probe

`GET /api/health` 必须为 200、`ok=true`、`schemaVersion=3`、`classificationSchemaVersion=1`，分类覆盖须为 195/195、`unclassifiedDocuments=0`，且 D1、R2、APIS、User Center、Assets 五项绑定均为 true。分类表采用加法子 schema，不提升全局 schema；因此发布后仍可直接回滚到 v4 Worker，而无需为代码回滚同步恢复 D1。

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

最近一次验证为 2026-07-15：生产 Worker `805f3f0d-ec68-49e1-8cff-cd1afa37910b`（deployment `ca6ca23f-1ae7-4698-b856-de228bfe6d37`），立即 Worker 回滚锚点为 `2c576476-b5fa-4789-a18e-7510b3fa3744`；预览版本为 `cf7aed3f-1313-49ae-9035-3e608bf1a42c`。`/api/health` 返回 `2026.07.15-v5`、全局 schema 3、分类子 schema 1、195/195 完整分类、175 份学科文档、20 份范围文档、0 未分类，五项绑定全真。迁移前生产 D1 Time Travel bookmark 为 `00000024-00000000-000050a9-d19c9e4a30d2b99a4a3c07e7336d6761`；`0004_document_classifications.sql` 为增量表且保持 v4 Worker 兼容。D1 含 FTS5 虚拟表，Wrangler 全库导出按 Cloudflare 已知限制被拒，因此 Time Travel 是本次数据库恢复锚点；R2 没有写入。

正式概念模型为 449 个概念观察点（其中 11 个范围/框架观察）、439 条非语义自动关系、7,578 个版本内出现记录和 5,000 条完整证据；星图核心 JSON 为 2,774,210 bytes，完整学术模型为 25,586,323 bytes，线上与本地 SHA-256 分别一致为 `73beb039dadd347883594515203f27b818f8250f1f09c7f5ee2206c7da1f53a1` 和 `005bf911dd2b6ed2e30994ce437d041d9792ceadca11e2e0e3007f24d2060992`。完整学术模型只作按需研究资产，首屏不会下载。桌面与 390×844 浏览器确认星图 29 个显式学科 facet 中没有课程方案、考试评价、考试大纲、综合、汇编或艺术与劳动，特殊教育真实课程仍保留；比较、资料和 AI 的学科合同同样只接受显式学科实体，范围文档继续保留在资料与金色范围节点中。移动端无横向溢出，预览和生产控制台均为 0 错误；42 项测试、TypeScript、Wrangler dry-run 与 OCR 健康检查通过。Pulse `/api/meta` 和 `/api/range` 均唯一命中该站，生产观测为 `worker_analytics` / `tracked` / 154 requests / 0 errors。OCR 队列为 25/8,232 页完成、8,207 待处理、0 失败、25/25 见证与审计、0 stale、0 可引文；8 页待人工图像核对、2 页待空白图确认、15 页 fail-closed。自动监督已恢复为 ACTIVE，每 10 分钟执行一个有界批次。

OCR 长任务由 `scripts/ocr-supervisor.mjs` 监管；`npm run ocr:check` 提供机器健康码，`npm run ocr:status` 查看锁、心跳、磁盘、见证、审计、复核和概念图覆盖。退出码合同为：`0` 健康、`2` 退避/局部隔离、`10` 运行或页/见证失败、`11` 停滞、`12` 全局硬停止、`75` 正在运行且锁归属有效。`npm run ocr:recover` 是显式绕过非隔离退避的单页恢复探针；它绝不绕过 quarantine。

Codex automation `Curriculum OCR quality supervisor` 每 10 分钟巡检；健康时最多处理一个 4 页批次，失败时先处理 1 页恢复探针，并最多补齐同一 4 页故障批次。批次内部 Apple Vision 会在 2 秒、10 秒后用全新进程重试失败页；之后才写入页级退避。低于 50 GiB 告警、低于 25 GiB 停止；未知进程不清理，失败页不放行。单页/单文档隔离不会阻断其他合格任务；共享 runtime、模型校验和、磁盘才是全局阻断。质量优先模式绝不复用已有 8112 服务，因为 llama `/props` 不能证明 mmproj 指纹；端口已占用时 fail-closed，由当前 run 启动并回收自己的精确 runtime。

Paddle 异常退出后仍重读 state，保留部分成功页，并为每个未完成页补齐 retry。Apple Vision sidecar 必须具备文档、页码、PDF 和图像 SHA；主 OCR 内容与 result 文件在进入审计前重新核对 state SHA。概念候选写入版本化 run 目录，只有 graph/quality revision 匹配且验证通过后才原子切换单一 manifest；保留当前和前一 last-good。保持已发布图和 Git 工作树不变；禁止自动部署、导入 D1、写 R2、提交或推送。只有人工证据复核和正式 `npm run concepts:build` 才能更新可发布图。

2026-07-15 故障恢复验证：`legacy-compendium-chinese` 1–4 页原 Apple Vision `nilError` 已分别通过 Vision、Paddle、页级审计恢复；10–20 页 11 份缺身份哈希的旧见证已重建。最终 `ocr:check` 为 0，25 个完成页对应 25 个有效见证，错误 sidecar、完成页缺见证、Paddle 失败页和隔离均为 0。15 页仍为 `unresolved_fail_closed`，属于内容质量门而非运行故障，不进入引文。

## 日常检查

- 每周：失败 OCR 队列、未核验冲突、匿名讨论待审核、AI 引文失败、Worker 错误率。
- 每月：官方目录与修订动态复查、来源 URL 可用性、R2 清单与本地 SHA 对账。
- 扫描件每次新增或更换：重算源 SHA、重新准备 OCR 队列，不继承旧页的通过状态。
- 自动监控只推进 OCR 与本地概念图候选更新；任何节点升级为可引用、进入正式关系或上线仍须人工证据门与发布验证。
- 日志只保留服务、版本、路径组、状态和错误类别；不写 cookies、session、原始研究问题或学生内容。
