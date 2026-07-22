# 管理控制面

`/admin` 是面向服务端白名单管理员的审核与运行控制面。它不是另一套内容来源，也不能直接改写已发布 D1 语料、OCR 结果、FTS 索引或概念图。所有研究内容仍须从 clean Git snapshot 经来源、页证据、编辑审核、preview 和 coordinated release 发布。

## 权限与数据边界

- 所有 `/api/admin/*` 读取先由 User Center session 校验，再由 `ADMIN_SLUGS` 服务端白名单授权；前端隐藏不构成权限控制。
- 写操作要求 same-origin，参数使用固定枚举和 D1 bind；管理 API 不接收 SQL、表名、列名或任意文件路径。
- AI 故障视图不返回 `actor_hash` 或 `query_hash`，只返回模型、学科筛选、状态、时间及检索/引用数量。
- 举报处置用一次恰好四条写语句的 D1 batch 完成唯一 claim、讨论状态、审计记录和最终状态。Claim 与讨论更新同时绑定预读的举报编号、讨论编号和讨论状态；期间若另一管理员已审核讨论，四条写入均为 no-op 并返回 409，不覆盖新状态，也不写陈旧审计。
- 已发布正文、术语、关系、版本结论、页证据和 release 状态在 UI 中只读。导入、索引和回滚只允许使用 `docs/deployment.md` 的不可变发布流程。

## 页面与 API

| 页面区域 | API | 能力 |
|---|---|---|
| 概况 | `GET /api/admin/overview` | D1 内容量、页门、讨论/举报、7 日 AI 失败、当前 corpus release |
| 资料与证据 | `GET /api/admin/inventory` | allowlist 内的文件、章节、段落、术语、关系、版本结论和页证据检索 |
| 讨论 | `GET /api/admin/comments`、`PATCH /api/admin/comments/:id` | 全状态只读清单及带 before/after 的审核 |
| 举报 | `GET /api/admin/reports`、`PATCH /api/admin/reports/:id` | 开放/已处置清单及并发安全的举报—讨论联合处置 |
| AI | `GET /api/admin/ai-logs` | 隐私最小化的成功/失败引文运行记录 |
| 审计 | `GET /api/admin/audit` | 操作者、动作、对象、before/after 与时间，只读 |

`inventory.kind` 只允许：`documents`、`chapters`、`paragraphs`、`terms`、`relations`、`versions`、`evidence`。查询中的 `%`、`_` 和反斜杠按普通字符转义；limit 最大 200。

讨论、举报、AI 故障、审计与资料清单都显示服务端 `total`、当前显示区间和 `offset`，并提供上一页/下一页；任何记录都不能因固定首屏上限而只能通过 API 访问。保留讨论会把举报标记为 `dismissed`，删除讨论才把举报标记为 `resolved`。当前管理栏目使用 `aria-pressed` 暴露选中状态；分页或处置重绘后焦点回到对应栏目标题，并通过独立 `role=status` 区域播报结果。

## 核查标准

1. 无 session 返回 401；已登录非管理员返回 403；两者都不得查询 D1 管理数据。
2. 非同源 PATCH 返回 403，非法状态、过短理由和不存在/已处理举报分别返回 400、404 或 409。
3. 逐个 inventory kind 及讨论清单分别在真实 `0001`—`0007`、`0001`—`0008`、`0001`—`0009` schema 上执行，不能只用接受任意 SQL 的 mock；dual-schema receipt 同时绑定 `src/admin.ts` 与完整 Worker bundle bytes。
4. 举报处置后 `comment_reports`、`comments` 与 `content_audit_log` 三者一致；重复处置不产生第二条审计；预读后插入另一管理员审核时必须得到四个零变更和 409。
5. API 响应、Worker 日志和浏览器控制台均不得出现 cookie、session、IP、原始用户/查询哈希或秘密。
6. 用超过一页的讨论、举报、AI、审计与每种资料清单验证 total/offset、前后翻页、保留=`dismissed`、删除=`resolved`、键盘选中状态、重绘焦点与 live confirmation。
7. preview 用真实 admin/non-admin 账号逐页验收，再以同一工件进入 production；管理页面不是公开导航入口，`robots.txt` 保持禁止 `/admin`。

聚焦回归：

```bash
node --test tests/admin-control-plane.test.mjs
npm run check
npm run build
```

整合后仍须运行完整 `npm test`、preview D1 readback、真实浏览器键盘/移动验收和 production 权限矩阵。

## 回滚

本候选不增加 migration，也不改变现有内容行。代码回滚只需恢复此前 Worker/Assets deployment；由本版本完成的合法讨论或举报审核记录属于业务数据，不随代码回滚删除。若发现误审核，管理员应以新的、有理由的审核动作纠正并保留完整审计链，不能直接删日志。
