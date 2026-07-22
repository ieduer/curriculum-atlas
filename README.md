# 中国历年课程标准与考试评价演变

面向教师的公共证据图谱。生产域名为 `https://curriculum.bdfz.net`，稳定站点标识为 `curriculum`，数据类别为 `teacher_owned`。

- 线上网站：<https://curriculum.bdfz.net>
- 公开源码：<https://github.com/ieduer/curriculum-atlas>

网站把课程标准、课程方案、教学大纲与考试评价资料呈现为一张全屏宇宙星图：年代决定星体位置，学科可直接显隐，跨学科模式连接同轮改革与已核验概念关系。版本、来源、检索和文档共用底部“版本与资料”工作区；AI 研究与教师讨论共用“教师研究”工作区，不再占用独立导航页。AI 只可引用 D1 中同时通过段落级、页级与对应文档或汇编篇目身份门的证据；讨论接入 BDFZ 统一用户中心，匿名内容经 Turnstile 后进入审核队列。

## 当前资料状态

- 195 条规范作品记录，其中 158 份普通学科资料、1 份考试学科资料、16 份课程资料、20 份范围/框架资料，未分类为 0。
- 101 份文档通过文档级引文闸门；其中 100 份同时达到当前概念抽取的年份与有效字符门槛。两条纯目录记录只用于缺口/修订跟踪，不计入正文引文。
- 16,456 个可检索段落。
- 85 份名义扫描记录进入 11,759 页的高质量 OCR 队列；扣除 68 页完全相同的劳动课标别名后为 84 个唯一 OCR 实体、11,691 页。队列覆盖数字以 `data/ocr-queue.json` 为准。
- 历史扫描件默认 fail-closed，不因完成 OCR 自动开放引文。
- 在线核对采用“扫描图像—多引擎 OCR—版本感知在线来源”三证规则；同篇异版只能旁证稳定事实。
- Apple Vision 页图由 SHA-256 固定的 MuPDF 1.28.0 以 240 DPI 渲染；有效见证可按源 PDF/页码/图像哈希复用，单页隔离不阻断其他合格页面。

数字由 `data/catalog.json`、`data/corpus-chunks/manifest.json` 和 `data/ocr-queue.json` 生成，不应手工维护。

## 技术结构

- Cloudflare Worker + Assets：TypeScript API 与静态 SPA。
- D1：资料、FTS5 段落索引、核验链、讨论、AI 引文审计。
- R2：可公开的来源清单与质量元数据；本地研究扫描件不公开再分发。
- `APIS` service binding：共享 `apis.bdfz.net` Gemini 网关。
- `my.bdfz.net/site-auth.js`：统一身份、认证访问及研究事件。
- Pulse：`bdfz-curriculum-atlas` Worker 请求统计。

## 本地验证

```bash
git clone https://github.com/ieduer/curriculum-atlas.git
cd curriculum-atlas
npm ci
npm run verify
```

本地开发运行 `npm run dev`。Cloudflare 账户变量与 Worker secrets 的名称见 `.env.example`；真实值只应进入本机批准的秘密存储或使用 `wrangler secret put` 安装，不能提交到仓库。

最初十九节需求的当前完成度、退出硬门与后续关键路径见 [docs/original-goal-delivery-matrix.md](docs/original-goal-delivery-matrix.md)。完整的数据方法与 OCR 闸门见 [docs/data-methodology.md](docs/data-methodology.md) 和 [docs/ocr-quality.md](docs/ocr-quality.md)；12 学科分面深层概念模型的 fail-closed 证据合约见 [docs/ONTOLOGY_CONTRACT_V2.md](docs/ONTOLOGY_CONTRACT_V2.md)。资产主账与数据层审计分别见 [docs/project-asset-ledger.md](docs/project-asset-ledger.md) 和 [docs/project-data-integrity-audit-2026-07-16.md](docs/project-data-integrity-audit-2026-07-16.md)。宇宙星图的信息架构、交互与视觉验收门槛见 [docs/frontend-reproduction-verification.md](docs/frontend-reproduction-verification.md)。部署、回滚与日常运维见 [docs/deployment.md](docs/deployment.md) 和 [docs/operations.md](docs/operations.md)；从立项到当前、可重新生成的完整运维事件总账见 [docs/project-operations-ledger.md](docs/project-operations-ledger.md)。

架构、数据模型与接手顺序分别见 [docs/architecture.md](docs/architecture.md)、[docs/data-model.md](docs/data-model.md) 和 [docs/ai-handoff.md](docs/ai-handoff.md)。公开资料的来源与再分发边界见 [docs/content-sources-and-rights.md](docs/content-sources-and-rights.md)。提交改进前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。
