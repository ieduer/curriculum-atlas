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

## 日常检查

- 每周：失败 OCR 队列、未核验冲突、匿名讨论待审核、AI 引文失败、Worker 错误率。
- 每月：官方目录与修订动态复查、来源 URL 可用性、R2 清单与本地 SHA 对账。
- 扫描件每次新增或更换：重算源 SHA、重新准备 OCR 队列，不继承旧页的通过状态。
- 日志只保留服务、版本、路径组、状态和错误类别；不写 cookies、session、原始研究问题或学生内容。
