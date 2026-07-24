# 中国历年课程标准与考试评价演变

面向教师的公共证据图谱。生产域名为 `https://curriculum.bdfz.net`，稳定站点标识为 `curriculum`，数据类别为 `teacher_owned`。

- 线上网站：<https://curriculum.bdfz.net>
- 公开源码：<https://github.com/ieduer/curriculum-atlas>
- 唯一项目手册：[docs/PROJECT_MANUAL.md](docs/PROJECT_MANUAL.md)

网站只有一张全屏宇宙星图：每颗星都是一次带年份和来源定位的概念观察，年代只是星体的空间坐标与星图内显隐条件，不再另设文件时间轴。左侧学科、检索与研究工具默认全部收起，底部列出 56 个实际有资料年份，可任意多选比较或一键选择 1902／2022；1950 年国家课程起点之前按 1902–1911、1912–1922、1923–1928、1929–1936、1937–1949 五个来源有界阶段在同一星图七点钟方向分区。461 个去重 bounded items 及后续 OCR 文件都是证据容器；OCR 提取的受控词面观察持续加入同一星图，且与已核节点使用完全相同的星体材质，不以虚线区分证据状态。点选任一概念，会隐藏无关星点，同时照亮纵向同层百年演进链与横向来源明示的学科分合关系；桌面检查器所在侧会成为星图保留观测区，相关星系自动重排至无遮挡空间，手机先显示紧凑摘要并在展开时同步压缩星图安全区。公开检索把「历史」「历史与社会」合为一个历史入口，底层仍保留两种课程形态；1923 合科、2001 综合／分科可选、2011 并行发标与 2022 标准组调整分别按来源标注，不表示身份等同、必然替代或地方实施。AI 只可引用 D1 中同时通过文档级和段落级白名单的证据；讨论接入 BDFZ 统一用户中心，匿名内容经 Turnstile 后进入审核队列。

## 当前资料状态

- 196 条编目记录，其中 160 份学科资料、16 份课程资料、20 份范围/框架资料，未分类为 0。
- 101 份文档通过文档级引文闸门；其中 100 份同时达到当前概念抽取的年份与有效字符门槛。两条纯目录记录只用于缺口/修订跟踪，不计入正文引文。
- 16,456 个可检索段落。
- 86 份扫描资料进入 11,847 页的 OCR 队列；物理去重为 85 份／11,779 页。2026-07-23 v15 候选覆盖已达 11,847／11,847、缺口 0；原三个超时区间 1,077 页由 Apple Vision 单见证候选补齐。6,947 页双见证队列已完整分为抽样、冲突、表格与空白确认四类，但引文就绪仍为 0。
- 历史扫描件默认 fail-closed，不因完成 OCR 自动开放引文。
- 百年星图已覆盖 11/11 公開學科檢索分面並保留 12 個底層課程形態：原 134 個語文／課程計畫嵌入條目繼續提供課程名稱觀察；2001 年前專科彙編現有 462 個來源雜湊綁定 bounded items，抽取 36 個實踐／內容／能力受控概念、426 個早期星點與 821 條 evidence。與 2001 年後同粒度觀測合併後，55 條概念族覆蓋 153 個受控概念和 1,597 個 episode memberships。
- `/archive` 將舊嵌入條目與專科 bounded items 按來源條目去重為 461 條，可按 11 個公開學科分面、篇名和候選詞面檢索；歷史入口同時檢索「歷史」「歷史與社會」，兩種課程形態仍分別保存。
- 在线核对采用“扫描图像—多引擎 OCR—版本感知在线来源”三证规则；同篇异版只能旁证稳定事实。
- Apple Vision 页图由 SHA-256 固定的 MuPDF 1.28.0 以 240 DPI 渲染；有效见证可按源 PDF/页码/图像哈希复用，单页隔离不阻断其他合格页面。
- 发布前执行 28 项不可人工覆盖的数据细度／准确度核查、20 项百年模型／多年份／无遮挡检查、候选 JSON Schema、episode stable-ID diff 与星图性能预算；生产部署还必须持有与当前公开资产指纹一致的 preview 桌面／手机运行收据。任一失败都在 Wrangler 之前阻断新版。

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
