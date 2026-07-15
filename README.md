# 中国历年课程标准与考试评价演变

面向教师的公共证据图谱。生产域名为 `https://curriculum.bdfz.net`，稳定站点标识为 `curriculum`，数据类别为 `teacher_owned`。

- 线上网站：<https://curriculum.bdfz.net>
- 公开源码：<https://github.com/ieduer/curriculum-atlas>

网站把课程标准、课程方案、教学大纲与考试评价资料连接成可检索的时间轴、学科视图、版本比较和概念关系。AI 只可引用 D1 中同时通过文档级和段落级白名单的证据；讨论接入 BDFZ 统一用户中心，匿名内容经 Turnstile 后进入审核队列。

## 当前资料状态

- 195 条编目记录。
- 103 份文档允许正文引文。
- 16,456 个可检索段落。
- 172 份本地 PDF 已进入来源清单，共 18,597 页；49 份扫描资料进入 8,232 页的高质量 OCR 队列。
- 历史扫描件默认 fail-closed，不因完成 OCR 自动开放引文。
- 在线核对采用“扫描图像—多引擎 OCR—版本感知在线来源”三证规则；同篇异版只能旁证稳定事实。

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

完整的数据方法与 OCR 闸门见 [docs/data-methodology.md](docs/data-methodology.md) 和 [docs/ocr-quality.md](docs/ocr-quality.md)。部署、回滚与日常运维见 [docs/deployment.md](docs/deployment.md) 和 [docs/operations.md](docs/operations.md)。

架构、数据模型与接手顺序分别见 [docs/architecture.md](docs/architecture.md)、[docs/data-model.md](docs/data-model.md) 和 [docs/ai-handoff.md](docs/ai-handoff.md)。公开资料的来源与再分发边界见 [docs/content-sources-and-rights.md](docs/content-sources-and-rights.md)。提交改进前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。
