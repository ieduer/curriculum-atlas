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

最近一次验证为 2026-07-15：生产 Worker `a53c6316-dbee-4e50-a5c2-fabac0fc73ee`，立即 Worker 回滚锚点为 `cefceec5-ec0a-427c-9ea9-c0be0eb19b20`；预览 Worker 为 `cc6dec86-d6ec-489e-b4c6-7c0b54f31dcd`，入口为 `https://bdfz-curriculum-atlas-preview.bdfz.workers.dev`，回滚锚点为 `3abb7b51-38e4-4005-87c6-ec53571cadb0`。生产与预览 `/api/health` 均返回 `2026.07.15-v6`、全局 schema 3、分类子 schema 1、196/196 完整分类：160 份学科资料、16 份课程资料、20 份范围/框架资料、0 未分类，五项绑定全真。迁移前生产 D1 Time Travel bookmark 为 `00000024-00000138-000050a9-92472a9486e03e820e754bf9815e5747`；D1 为 196 份资料、16,456 段、103 份可引文资料，原有 0 条评论、0 条举报和 2 条 AI 日志均保留。R2 生产和预览各重发 6 个可重建元数据对象；来源清单为 55,183 bytes、SHA-256 `0f0fda279b10ef40011ea28477deb528ed5d45b7478dfd93a8b7bf6d0b1cb16e`、ETag `"87c05b0e886a12155e1a8696719eda69"`，含 196 条、187 份已取源文件、9 份来源缺口，并包含经封面/CIP/ISBN/页数/SHA 核验的化学汇编。

正式概念模型为 452 个概念观察点、429 条非语义自动关系、7,583 个版本内出现记录和 5,004 条完整证据；核心 JSON 为 2,910,909 bytes，完整学术模型为 25,948,060 bytes，生产、预览与本地 SHA-256 三方分别一致为 `e8a1aa0f4089deac5019f9a24baf6b48ffc1622760920cd5680cf3bb8f861557` 和 `d7e49495683253356a513d413fffa7aac0f0930bf68dd659a525f27bedd738db`，build revision 为 `a88de4059a02b9d1ccdad0dacfc7c633bdfd55e9b2685267f7151d93b12b9411`。完整学术模型只作按需研究资产，首屏不会下载。学科控制来自受控 taxonomy 与 29 个稳定 facet 的交集：160 份学科资料可进入学科筛选，`定向行走`、`美工` 等 16 项课程只作为课程实体，课程方案/考试评价等范围实体也不能混入；7 个当前无 episode 的合法学科仍保留为 `· 0` 控件。生产 Playwright 在 1440×900 与 390×844 均确认 29 个控件、7 个零计数学科、无旧“静”/圆圈/复位控件、无横向溢出、无控制台或页面错误；隐藏语文使 452 星/429 关系降为 414/399，恢复后回到 452/429。55 项 Node 测试、TypeScript、两份监督器语法检查、Wrangler dry-run 和 `git diff --check` 均通过。未登录 AI 仍为 401，历史扫描 `legacy-compendium-chinese` 仍是 0 正文段且不可引文；Pulse 唯一映射该 Worker，核验窗口为 254 requests / 0 errors、`worker_analytics` / `tracked`。

OCR 运行快照（2026-07-15 12:05:58 UTC）为 346/8,690 页完成、8,344 页待处理、0 失败、0 错误 sidecar、0 隔离，磁盘约 99.6 GiB。64 页验收金丝雀 `2026-07-15T11-18-42-775Z-1a206bf2` 用时 1,238.156 秒，64/64 主 OCR、64/64 Apple Vision 见证和 64/64 页级审计全部齐全，哈希漂移、重试、失败与隔离均为 0；紧接的第二个完整 64 页批次用时 994.860 秒并同样零失败。两个批次加权吞吐为 3.438 页/分钟，即约 34.38 页/10 分钟，按当时剩余量估算中心值约 40.45 小时、观测区间约 36.03–44.84 小时。限制来自单个已饱和的 PaddleOCR-VL/Metal 推理实例，不是调度器的 16 页上限；并行第二个 Paddle worker 会争抢同一 GPU 和内存，故生产策略是单实例连续 64 页排空。艺术劳动 1–4 页和生物 1–4 页只有旧范围审计、缺逐页 exact audit；最新版调度器已将其识别为 `audit_backfill`，严格完结前会只补审计而不重跑两套 OCR。OCR 页仍全部 `citation_allowed=false`，机器排空不替代逐页图像、独立识别和同版在线文本的编辑核查。

OCR 长任务由 `scripts/ocr-supervisor.mjs` 监管；`npm run ocr:check` 提供机器健康码，`npm run ocr:status` 查看锁、心跳、磁盘、见证、审计、复核和概念图覆盖。退出码合同为：`0` 健康、`2` 退避/局部隔离、`10` 运行或页/见证失败、`11` 停滞、`12` 全局硬停止、`75` 正在运行且锁归属有效。`npm run ocr:recover` 是显式绕过非隔离退避的单页恢复探针；它绝不绕过 quarantine。

Codex automation `Curriculum OCR quality supervisor` 每分钟巡检，但在有效 drain 或批次 owner 存活时严格只读。生产 fast path 由单例 `ocr:drain -- --batch-pages 64` 连续排空；每个干净批次结束约一秒后直接进入下一批，不再等待自动化交接。只有 drain 不存在或死亡时，自动化才允许启动一个 sandbox-external 的 64 页兜底批次；失败时先处理 1 页恢复探针，并最多补齐同一故障批次的 3 个无效见证。批次内部 Apple Vision 会在 2 秒、10 秒、30 秒后用全新进程重试失败页；之后才写入页级退避。缺失或过期审计走 `audit_backfill`，只复用重新校验过的主 OCR 和 Vision 输入，硬性禁用 Vision 与 Paddle 重跑。低于 50 GiB 停止自动续跑，低于 25 GiB 硬停止；未知进程不清理，失败页不放行。单页/单文档隔离不会阻断其他合格任务；共享 runtime、模型校验和、磁盘才是全局阻断。质量优先模式绝不复用已有 8112 服务，因为 llama `/props` 不能证明 mmproj 指纹；端口已占用时 fail-closed，由当前 run 启动并回收自己的精确 runtime。

Paddle 异常退出后仍重读 state，保留部分成功页，并为每个未完成页补齐 retry。Apple Vision sidecar 必须具备文档、页码、PDF 和图像 SHA；主 OCR 内容与 result 文件在进入审计前重新核对 state SHA。概念候选写入版本化 run 目录，只有 graph/quality revision 匹配且验证通过后才原子切换单一 manifest；保留当前和前一 last-good。保持已发布图和 Git 工作树不变；禁止自动部署、导入 D1、写 R2、提交或推送。只有人工证据复核和正式 `npm run concepts:build` 才能更新可发布图。

2026-07-15 故障恢复验证：`legacy-compendium-chinese` 1–4 页原 Apple Vision `nilError` 已分别通过 Vision、Paddle、页级审计恢复；10–20 页 11 份缺身份哈希的旧见证已重建。该恢复批次结束时 `ocr:check` 为 0，25 个完成页对应 25 个有效见证，错误 sidecar、完成页缺见证、Paddle 失败页和隔离均为 0。15 页仍为 `unresolved_fail_closed`，属于内容质量门而非运行故障，不进入引文；后续连续排空的当前数字以上方带时间快照为准。

## 日常检查

- 每周：失败 OCR 队列、未核验冲突、匿名讨论待审核、AI 引文失败、Worker 错误率。
- 每月：官方目录与修订动态复查、来源 URL 可用性、R2 清单与本地 SHA 对账。
- 扫描件每次新增或更换：重算源 SHA、重新准备 OCR 队列，不继承旧页的通过状态。
- 自动监控只推进 OCR 与本地概念图候选更新；任何节点升级为可引用、进入正式关系或上线仍须人工证据门与发布验证。
- 日志只保留服务、版本、路径组、状态和错误类别；不写 cookies、session、原始研究问题或学生内容。
