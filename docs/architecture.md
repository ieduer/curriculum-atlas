# 技术架构

## 边界

```text
Browser
  ├─ Worker Assets: SPA, stable reading interface, atlas visualization
  └─ Worker API
       ├─ D1: catalog, FTS5, verification evidence, comments, AI audit
       ├─ R2: rebuildable public metadata manifests
       ├─ USER_CENTER binding: session, role and privacy-bounded events
       └─ APIS binding: managed Gemini gateway
```

原始 PDF、OCR 中间图像和受再分发限制的扫描件仅保存在本地研究区，不属于公开部署资产。生成流程把可公开元数据写入 D1/R2；未通过文档级与段落级闸门的文本不能进入搜索或 AI 引文。

产品和工程的唯一总入口是 `docs/PROJECT_MANUAL.md`。本文件只解释技术分层，不能另行定义第二套产品轴线。

## 单一星图投影

前端只渲染一个概念观察图。现行正式观察来自 `public/data/concept-evolution.json`；百年汇编 OCR 候选由 `scripts/build-century-observation-layer.mjs` 从 134 个内嵌篇目生成 `public/data/century-observation-layer.json#star_projection`；五个固定概念层级、55 条百年概念族由 `scripts/build-concept-evolution-families.mjs` 生成 `public/data/concept-evolution-families.json`。应用启动时合并 episode、evidence、族谱 membership 与非因果关系后一次性交给 Canvas。

时间只是 episode 的 `year` 坐标和左侧筛选条件。文档、汇编篇目、页段与 OCR 运行记录都留在 archive/evidence 层，不成为星体，也不产生独立时间轴。候选 OCR 星恒为非语义、不可引文，但外观与正式星完全一致；只有后续独立核验才能进入更高证据层。族谱关系平时不渲染，点击一个概念后才照亮全族并画实线关系，避免长跨度线在未选中状态被误读。

## 运行时

- `src/index.ts`：路由、资料、搜索、讨论和管理 API。
- `src/retrieval.ts` / `src/ai.ts`：白名单检索、共享模型网关和引文完整性检查。
- `src/auth.ts`：User Center service binding 优先的会话验证。
- `src/security.ts`：CSP、CORS、HMAC 限流标识和输入边界。
- `public/`：无框架 SPA；`scripts/build-site.mjs` 生成 `dist/`。
- `migrations/`：D1 schema 的唯一来源；不可直接手改生产表结构。

## 数据发布

`data/*.json` 是可审计清单，`scripts/build-corpus.mjs` 生成未纳入 Git 的 SQL 分片，`scripts/import-corpus.mjs` 幂等导入 D1。R2 只保存可重建的来源与质量清单。完整命令见 `docs/deployment.md`。

## 依赖

本项目是 BDFZ 叶站点。它依赖 User Center 和 APIS 两个共享合约；任何会话或 AI 网关合约变化都必须回归本网站与 Companion。公共发现还依赖 Nav、Portal、Companion 与 Pulse 的同步登记。
