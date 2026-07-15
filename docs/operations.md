# 运维与八点验证标准

## 1. Source of truth

代码与生成规则：`/Users/ylsuen/CF/curriculum-atlas`。官方目录与本地扫描库存只进入 `data/*.json` 和 `.cache/` 研究区；D1/R2 是部署产物，不反向覆盖来源。

## 2. Health probe

`GET /api/health` 必须为 200、`ok=true`、`schemaVersion=3`，且 D1、R2、APIS、Assets 四项绑定均为 true。

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

最近一次验证为 2026-07-15：生产 Worker `2c576476-b5fa-4789-a18e-7510b3fa3744`，立即回滚锚点 `7709c041-c541-4baa-babb-3c7f29b18a30`；`/api/health` 返回 `2026.07.15-v4`、schema 3 与五项绑定全真。D1/R2 未变更，发布前 D1 Time Travel bookmark 为 `0000001d-00000000-000050a9-681d1945fdef8d2ab5746e1ef6faef7f`。正式图数据为 399 个概念观察点、427 条仅表示相邻观察/共同观察的关系、1,054 条证据，其中 396 个节点达到段落引文门槛、3 个历史节点只能显示人工复核警示。桌面与 390×844 浏览器验收、概念搜索、年代截断、学科显隐、谱系/跨学科切换、候选证据禁链、15 项测试和预览/生产控制台零错误均通过。

OCR 长任务由 `scripts/ocr-supervisor.mjs` 监管；`npm run ocr:status` 查看锁、心跳、磁盘、见证、审计、复核和概念图覆盖。Codex automation `Curriculum OCR quality supervisor` 每 30 分钟最多处理一个 4 页批次，低于 50 GiB 告警、低于 25 GiB 停止；未知进程不清理，失败页不放行。OCR 完成后只在 `.cache/ocr-supervisor/` 原子重建并验证候选概念图，保持已发布图和 Git 工作树不变；禁止自动部署、导入 D1、写 R2、提交或推送。只有人工证据复核和正式 `npm run concepts:build` 才能更新可发布图。

## 日常检查

- 每周：失败 OCR 队列、未核验冲突、匿名讨论待审核、AI 引文失败、Worker 错误率。
- 每月：官方目录与修订动态复查、来源 URL 可用性、R2 清单与本地 SHA 对账。
- 扫描件每次新增或更换：重算源 SHA、重新准备 OCR 队列，不继承旧页的通过状态。
- 自动监控只推进 OCR 与本地概念图候选更新；任何节点升级为可引用、进入正式关系或上线仍须人工证据门与发布验证。
- 日志只保留服务、版本、路径组、状态和错误类别；不写 cookies、session、原始研究问题或学生内容。
