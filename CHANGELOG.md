# 变更记录

本项目遵循日期化发布记录；生产资源的精确版本、验证证据与回滚锚点另见 `docs/operations.md` 和本机 canonical operations report。

## 2026-07-18 — fenced publication v2（未部署）

- 新增唯一 `curriculum_desired_release_v2` artifact：从 clean、upstream-exact Git HEAD 的 blob 构建 `dist`，并让 Worker 变量、corpus、R2 manifest 与环境证据共享同一组 Git/release/source-tree/corpus pin；观测时间、health、pointer 与治理回执不进入 release identity。
- 新增 `0008_release_ownership_fences.sql`，为 corpus import 与 R2 publication 分别提供 owner token、单调 fence、expiry takeover；所有 start/resume/chunk/failure/finalize/renew 路径均由 live owner/fence 保护，首次导入前保存未经改写的 D1 Time Travel receipt。
- Corpus importer 现在一次封存完整 builder inputs、text assets、manifest 与 SQL；chunk 数据和 receipt 在同一个 guarded batch 中提交，接管后旧 owner 不可继续写入。
- Corpus import 在第一次远端命令前把 live 与 private-snapshot envelope 两次精确绑定到唯一 desired-release artifact；同一 release 已 `ready` 的重跑只返回 `already_ready`，不清空 receipts 或倒退 current metadata。
- R2 只允许 authenticated Worker coordinator 写入：immutable objects 使用 `If-None-Match: *`，pointer 使用 predecessor ETag 的 `If-Match`，激活前在 coordination-schema-3、最长 600 秒的 D1 claim 内分页核对完整 prefix 与逐对象 body/hash/bytes/HTTP Content-Type/custom metadata；claim 阻止受支持的 lease takeover，legacy schema-1 predecessor 只能以精确 manifest body hash/bytes 接管。
- 新增可执行的 higher-fence R2 pointer rollback：canonical schema-2 `inspect-pointer` receipt 只提供目标身份，publisher 先验证当前 desired Worker/D1 environment，再由 coordinator 重验历史 immutable release 并条件激活；禁止直接覆盖旧 pointer bytes 或绕过 coordinator 写 D1/R2。
- 新增真实 SQLite 全迁移、Miniflare D1/R2、Wrangler dry-run、Git/worktree race 与 publisher sealed-byte 回归。该条仅记录本地源码能力；preview/production 在应用 `0008`、安装 secret、部署并完成 live verification 前仍是 legacy v10 状态。

## 2026-07-17 — v10 taxonomy / corpus / R2 发布

- Preview 与 production D1 均已应用 `0001`–`0007`，运行全局 schema 3、taxonomy schema 2、page publication schema 1；Worker 均升级为 `2026.07.16-v10`。
- 发布 taxonomy 精确口径：159 份普通学科资料、1 份考试学科、16 份课程、20 份范围／框架；公开星图为 12 个展示分面，API 保留 28 个普通学科精确查询身份。
- 原子导入并激活 `corpus-358471fcce862b2f0ae446fc`：196 documents、16,456 paragraphs、16,456 FTS、6,031 page gates、16,456 displayed、0 accepted OCR、91/91 chunk receipts。
- Production Worker version 为 `28c7e6d4-1638-42bc-b371-bd8d24210b93`，deployment 为 `baa8a92f-ccc8-4972-b0ad-6d67876cdc84`，静态资产绑定 Git `57487dc95481391cbcd40e0be0c92ee2d1ed8fdf`；preview 对应 version `2d107d38-cf31-49b6-82b1-20b32a32e824`、deployment `32b91e16-302a-4672-b55d-4e73bcedf54a`、Git `40cb114e410e5f2afc886732eb146707edf8477b`。
- Production 首次激活 versioned R2 release `release-9cb02f77c06ee0535e7981a22b312373`；pointer 为 388 bytes / SHA-256 `5142166d000fbf82e6d0a9d135a5340ba3c9d77f3bed803967ad565ff8c2133a`，manifest 为 107,777 bytes / SHA-256 `a6a15ea83cc58b1b84f5587a110c0fddeb414f24c77ff534507ea96868c03964`，17 个对象共 546,648 bytes 三方逐字节一致。Preview release 为 `release-841a528f0086ce69f2f7a6f2d07c0999`。
- Production `/api/source-manifest` 返回 55,183 bytes / SHA-256 `0f0fda279b10ef40011ea28477deb528ed5d45b7478dfd93a8b7bf6d0b1cb16e`；完整本地发布链通过 380/380 tests，环境证据提交为 `290755749a0257ed720e7b2d26aa6b972c60aebb`。
- Production 只读终验事件 `2026-07-17T06:35:37.437Z` 通过：health 200 / v10 / Git `57487dc` / schema 3-2-1 / 五项 binding；三种视口（1440×1000、1280×720、390×844）均无横向溢出，完整星图 553 颗概念星、214 条谱系、261 条跨学科关系，全隐藏 0/0，语文 143/60 且无“运动能力”串科，桌面与移动单科缩放分别从 0.864→1.32、0.20→0.568；深链接、工作台、拖拽和缩放均通过。
- 同一终验前后 D1 用户/运维表计数保持 0/0/3/2/0，canonical digest 均为 `c4166f451f4b9529bf4221b56fb3017dc51aef7493a699553dc218287e42c430`；Pulse 为 425 requests / 0 errors。第一方 console/page error 为 0；仅 Turnstile 第三方 opaque challenge 产生 2 errors / 5 warnings。
- 私有原始资料与 OCR 证据已加密分片上传并完成全量 GET/hash/decrypt/decompress/replay；索引在 `backups/curriculum-atlas/private-archive/20260717T021000Z/archive-index.json`。不在文档或日志中记录密钥。
- OCR 仍严格 fail-closed：本机 primary/audit 6,947/11,847、Vision 7,012、accepted display/citation 0；DMITPro2 B-r1 因内存门冻结在 1,259/3,182。概念 observation 数据目前止于 2020；2022 corpus 文档和年代轨虽已存在，仍须在 accepted OCR 闭环后重建概念观察。只有 hash-bound seed lineage 实现并测试通过后，才可在新配置下创建 B-r2；本节不声明 OCR 完成或 OCR 正文上线。

## 2026-07-16 — 未发布数据完整性收口

- 新增可重建的全项目运维总账、资产主账与数据完整性审计；不改写历史事件。
- 将 245 个 PDF 路径／209 个唯一实体统一为 canonical、variant、derived、quarantine disposition，并把 Downloads 命中的 15 本汇编全部对账。
- Catalog 扩展至 196 条并改用显式正文／引文资格；当前 101 份真实正文可进入语料，OCR accepted 仍为 0。
- 新增 D1 corpus release、91 个 SQL chunk hash/bytes/receipt 与 Worker fail-closed release gate。
- R2 改为 17 个策略驱动不可变对象与单一 `release/current.json` pointer；新增命令回执、部署版本、Git 静态资产、D1 migration/corpus 与 health 绑定的环境证据对象，本机 Worker 支持完整 pointer/manifest/object 校验。
- 当日本地收口时 preview 与 production 尚未应用 0005/0006；这一历史阻断已由 2026-07-17 v10 发布解除，不能再作为当前状态。

## 2026-07-15 — 1.0.0

- 上线课程标准与考试评价证据图谱、全文检索、版本比较、关系视图和响应式阅读界面。
- 建立 195 条资料目录、16,456 个可检索段落和 103 份可引文文档。
- 建立质量优先 OCR 队列，以及扫描图像、多引擎 OCR、版本感知在线来源三证核查标准。
- 加入证据锁 AI、统一账户讨论、匿名 Turnstile、防滥用与引文审计。
- 接入 User Center、共享导航、门户、Companion 源码入口和 Pulse 监控。
- 建立 preview/production D1、R2、Worker、备份、验证和回滚文档。
