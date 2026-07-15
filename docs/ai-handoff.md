# AI / 开发者接手说明

## 必读顺序

1. `README.md`
2. `docs/architecture.md`
3. `docs/data-methodology.md`
4. `docs/ocr-quality.md`
5. `docs/data-model.md`
6. `docs/deployment.md`
7. `docs/operations.md`
8. `/Users/ylsuen/CF/runbooks/bdfz_project_matrix_and_interdependencies.md`（仅 BDFZ 内部运维环境）

## 不可突破的边界

- 不把低质 OCR、目录元数据、搜索摘要或模型补写当作原文。
- 只有同文同版在线文本可以校正文句；异版只能旁证稳定事实。
- 冲突未解决时标记 `human_judgment_with_warning`，说明风险并保持引文关闭。
- 不把原始 PDF、整本受版权约束转录、用户数据或秘密提交到 GitHub/R2。
- 不为叶项目创建 Gemini key；只用 `APIS` binding。
- 不绕过 User Center 自建账户系统。
- 不直接试错生产；先在 preview 完成迁移、数据和浏览器验证。

## 修改闭环

1. 确认来源与实际运行路径。
2. 对风险变更记录备份/Time Travel/Worker 版本。
3. 做最小修改并运行 `npm run verify`。
4. 在 preview 验证 health、meta、搜索、详情、AI、身份和讨论。
5. 发布后回归 User Center、Nav、Portal、Companion 和 Pulse。
6. 更新 `CHANGELOG.md`、项目运维文档、canonical report 与 action log。

## 当前已知未决

50 份可运行扫描任务、8,690 页进入质量优先 OCR 队列。它们在逐页识别、篇目定位、同版在线核查和冲突裁决完成前保持 fail-closed。Companion 源码入口已登记，但新安装包需在真实 Android 设备验证后才能发布。
