# 中国历年课程标准与考试评价演变

面向教师的公共证据图谱。生产域名为 `https://curriculum.bdfz.net`，稳定站点标识为 `curriculum`，数据类别为 `teacher_owned`。

- 线上网站：<https://curriculum.bdfz.net>
- 公开源码：<https://github.com/ieduer/curriculum-atlas>
- 唯一项目手册：[docs/PROJECT_MANUAL.md](docs/PROJECT_MANUAL.md)

网站只有一张全屏宇宙星图：每颗星都是一次带年份和来源定位的概念观察，年代只是星体的空间坐标与星图内显隐条件，不再另设文件时间轴。左侧学科、检索与研究工具默认全部收起，年份控制横向嵌入星图底部；1950 年国家课程起点之前按 1902–1911、1912–1922、1923–1928、1929–1936、1937–1949 五个来源有界阶段在同一星图七点钟方向分区。340 个去重 bounded items 及后续 OCR 文件都是证据容器；OCR 提取的受控词面观察持续加入同一星图，且与已核节点使用完全相同的星体材质，不以虚线区分证据状态。点选任一概念，会隐藏无关星点，同时照亮纵向同层百年演进链与横向来源明示的学科分合关系；选中星系可一键放大。历史与历史与社会保持两条独立纵向课程链，1923 年社会科只以同年合科关系实线连接公民、历史与地理，不表示替代、因果或由历史演变而来。AI 只可引用 D1 中同时通过文档级和段落级白名单的证据；讨论接入 BDFZ 统一用户中心，匿名内容经 Turnstile 后进入审核队列。

## 当前资料状态

- 196 条编目记录，其中 160 份学科资料、16 份课程资料、20 份范围/框架资料，未分类为 0。
- 101 份文档通过文档级引文闸门；其中 100 份同时达到当前概念抽取的年份与有效字符门槛。两条纯目录记录只用于缺口/修订跟踪，不计入正文引文。
- 16,456 个可检索段落。
- 86 份扫描资料进入 11,847 页的高质量 OCR 队列；物理去重为 85 份／11,779 页。2026-07-23 帐本中 runtime 已完成 10,690 页，另有双见证证据补足候选覆盖至 10,770 页；其余 1,077 页全部落在三个显式缺口，没有 silent missing。
- 历史扫描件默认 fail-closed，不因完成 OCR 自动开放引文。
- 百年星图已覆盖 12/12 学科：原 134 个语文／课程计划嵌入条目继续提供课程名称观察；2001 年前专科汇编新增 341 个来源哈希绑定 bounded items，抽取 36 个实践／内容／能力受控概念、326 个早期星点与 645 条 evidence。与 2001 年后 40 个同粒度概念、97 个版本星点合并后，55 条概念族覆盖 153 个受控概念和 1,497 个 episode memberships。
- `/archive` 将旧嵌入条目与专科 bounded items 按来源条目去重为 340 条，可按 12 学科分面、篇名和候选词面检索。
- 在线核对采用“扫描图像—多引擎 OCR—版本感知在线来源”三证规则；同篇异版只能旁证稳定事实。
- Apple Vision 页图由 SHA-256 固定的 MuPDF 1.28.0 以 240 DPI 渲染；有效见证可按源 PDF/页码/图像哈希复用，单页隔离不阻断其他合格页面。
- 发布前执行 24 项不可人工覆盖的数据细度／准确度核查、候选 JSON Schema、episode stable-ID diff 与星图性能预算；生产部署还必须持有与当前公开资产指纹一致的 preview 桌面／手机运行收据。任一失败都在 Wrangler 之前阻断新版。

数字由 `data/catalog.json`、`data/corpus-chunks/manifest.json`、`data/ocr-queue.json` 和 `data/ocr-coverage-ledger.json` 生成，不应只改前端文案。

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

项目目标、单星图产品合同、OCR 持续投影、发布门槛、运维和路线图以 [docs/PROJECT_MANUAL.md](docs/PROJECT_MANUAL.md) 为唯一总入口；本轮整体问题、优先级与 1950 年前分期依据见 [docs/PROJECT_AUDIT_2026-07-23.md](docs/PROJECT_AUDIT_2026-07-23.md)。数据方法与 OCR 闸门见 [docs/data-methodology.md](docs/data-methodology.md) 和 [docs/ocr-quality.md](docs/ocr-quality.md)。资产主账与数据层审计分别见 [docs/project-asset-ledger.md](docs/project-asset-ledger.md) 和 [docs/project-data-integrity-audit-2026-07-16.md](docs/project-data-integrity-audit-2026-07-16.md)。宇宙星图的信息架构、交互与视觉验收门槛见 [docs/frontend-reproduction-verification.md](docs/frontend-reproduction-verification.md)。部署、回滚与日常运维见 [docs/deployment.md](docs/deployment.md) 和 [docs/operations.md](docs/operations.md)；从立项到当前、可重新生成的完整运维事件总账见 [docs/project-operations-ledger.md](docs/project-operations-ledger.md)。

架构、数据模型与接手顺序分别见 [docs/architecture.md](docs/architecture.md)、[docs/data-model.md](docs/data-model.md) 和 [docs/ai-handoff.md](docs/ai-handoff.md)。公开资料的来源与再分发边界见 [docs/content-sources-and-rights.md](docs/content-sources-and-rights.md)。提交改进前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。
