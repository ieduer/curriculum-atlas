# Curriculum Atlas 数据与资产完整性审计（2026-07-16）

## 执行摘要

本轮把项目从“若干文件、OCR 目录、D1 表和 R2 JSON 各自可用”收束为一条可审计、可阻断、可回滚的发布链。结论如下：

- 资产层已完成统一盘点：245 个 PDF 路径对应 209 个唯一 SHA-256 实体；201 个 canonical、3 个 variant、2 个 derived、3 个 quarantine。Downloads 内命中的 15 本课程标准汇编已全部在项目来源根登记。
- 编目层固定为 196 条：101 条 `official_native_text` 可进入正文语料，88 条仍处 OCR 质量流程，2 条只作目录元数据，5 条不可用。文件格式和文件名不再隐式提升正文或引文资格。
- OCR 的名义分母为 86 份／11,847 页，物理去重分母为 85 份／11,779 页。当前本机闭环为主 OCR 6,947 页、Apple Vision 见证 7,012 页、exact audit 6,947 页；显示放行 0 页、引文放行 0 页。
- 最终 v4 语料 release `corpus-f56f6fac3e022bb24ad69265` 已绑定 101 份真实正文、196 个目录身份、16,456 段、16,456 条 FTS、6,031 个页级门和 91 个 SQL 分块，并对 13 项核心表计数形成闭包。每个分块均有 SHA-256、字节数及 D1 导入回执；任一结构、归属或计数不符均不得转为 `ready`。
- Worker 已在本机支持 R2 `release/current.json` → 不可变 release manifest → versioned object 的完整哈希读取；若 pointer 存在但漂移，绝不回退旧固定 key。
- preview 和 production 没有在本轮变更。它们仍停在 migration `0004` 与 `stable_keys_v0`，因此被发布清单明确阻断；不能把本机完成描述为已上线。

本报告是当前数据层审计说明。完整的逐条历史、生产/预览快照、每次操作的证据、回滚和未决项见 [`project-operations-ledger.md`](project-operations-ledger.md)。

## 权威状态矩阵

| 层 | 权威输入 | 当前数字／版本 | 发布判断 |
|---|---|---|---|
| 物理资产 | `data/artifact-registry.json` + 项目来源根 | 245 PDF paths；209 unique SHA；3 variant；2 derived；3 quarantine | 资产审计通过；2 个 derived 因谱系不完整继续阻断 |
| Catalog | `data/catalog.json` | 196 records；101 native；88 OCR 流程；2 metadata-only；5 unavailable | 所有记录均显式给出质量与引文 disposition |
| Ingest | `data/ingest-manifest.json` | 196 entries；与 catalog ID 精确一致 | 身份层通过；不等于正文质量通过 |
| OCR queue | `data/ocr-queue.json` | 名义 86／11,847；唯一实体 85／11,779；blocked 2 | 未完成；全部扫描文本默认 fail-closed |
| OCR evidence | `.cache/ocr-supervisor/status.json` | primary/audit 6,947；Vision 7,012；reviewed 4；citation 0 | `legacy-compendium-chemistry:84:paddle` 隔离；其余仍需图像／同版在线裁决 |
| Page publication | `data/page-publication-manifest.json` | accepted documents 0；accepted pages 0 | 没有 OCR 文本进入公开正文 |
| Semantic gate | `data/semantic-publication-policy.json` | 1 exact alias；21 page controls | 未解决控制优先覆盖未来 acceptance |
| Corpus | `data/corpus-chunks/manifest.json` | v4 release `corpus-f56f6fac3e022bb24ad69265`；196 documents；101 text assets；16,456 paragraphs；6,031 gates；91 chunks；13 项 core counts | 本机构建通过；远端 D1 未导入本 release |
| Concept graph | `public/data/concept-evolution*.json` | revision `d6d695c1…`；553 episodes；475 edges；7,821 occurrences；5,228 evidence | 本地生成物；OCR 未放行，因此不含未审 OCR 正文 |
| Deep ontology | academic graph | 169 nodes；175 relations；21 evidence anchors | 语文深层模型已有；不得外推为全学科完成 |
| Worker source | `src/index.ts` | v9 working tree；corpus-ready gate + versioned R2 reader | 本机测试通过；未部署 |
| Preview | 最后只读远端快照 | Worker v8；D1 0004；R2 stable keys | blocked：0005、0006、versioned reader 未上线 |
| Production | 最后只读远端快照 | Worker v7；D1 0004；R2 stable keys | blocked：0005、0006、versioned reader 未上线 |

## 数据链与阻断点

```mermaid
flowchart LR
  A["PDF / HTML / catalog source"] --> B["artifact registry + SHA-256"]
  B --> C["catalog + ingest identity parity"]
  C --> D["OCR queue"]
  D --> E["primary OCR"]
  E --> F["Apple Vision witness"]
  F --> G["exact page audit"]
  G --> H["same-edition online verification"]
  H --> I["page publication manifest"]
  I --> J["semantic publication gate"]
  J --> K["corpus release + D1 receipts"]
  K --> L["concept graph / search / AI"]
  L --> M["versioned R2 + Worker Assets release"]
```

任一箭头前的输入缺失、身份漂移、版次不一致或计数不符，后续层均保持关闭。OCR 产物存在只代表 E，不代表 I、K 或 M。

## 本轮发现及处置

### 1. 遗忘和歧义资产

发现三份同版替代扫描 `biology-b.pdf`、`math-b.pdf`、`politics-b.pdf`，以及两个加 OCR 层的派生 PDF。此前它们没有统一 disposition，后续脚本可能漏掉或误用。

处置：

- 三份替代扫描登记为 `variant`，仅允许图像、页序和字符交叉核查；不进入 OCR 队列与发布。
- 两个 OCR 层 PDF 登记为 `derived`，在父哈希、工具、参数和逐页证据完整前保持 `queue_eligible=false`、`publication_eligible=false`。
- 三个唯一的零载荷实体登记为 `quarantine`；四条路径不再被误认作有效 PDF。
- `.cache/sources/moe-hs-2020.zip` 作为 archive container 单独记录哈希、字节数和 ZIP magic。
- 同 SHA 的 `moe-2022-17` 与 `ictr-6c6df9d121ac` 建立 exact alias；目录身份仍保留两条，物理 OCR 工作量只计一次。

自动门：`scripts/audit-project-assets.mjs` 现在联合检查 catalog、source、ingest、artifact、磁盘和 queue。漏记文件、别名缺失、magic/hash 漂移或队列覆盖不全均退出 1。

### 2. 隐式正文资格

旧规则会依据 `html`、`pdf_in_zip` 或 `neea-2019-*` 文件名推断 native/citation。这样一旦格式或命名被复用，未核正文可能直接进入语料。

处置：

- 196 条 catalog 记录必须显式提供 `text_quality_status` 和布尔 `citation_allowed`。
- 21 条高中 2020、12 条 NEEA 2019、6 条官方政策 HTML 明确声明 `official_native_text`；2 条纯目录记录为 `metadata_only` 且不可引文。
- `build-catalog`、`build-corpus`、概念构建与页门共用显式判定；不再用文件格式兜底。
- 正确口径从旧远端的 103 个文档门收敛为本地 101 个真实正文门；其中 100 个达到当前概念抽取的年份和有效字符条件。

### 3. 非原子 D1 语料导入

旧 importer 逐 SQL 文件写入，没有整批 release 状态；中断时可能同时存在新旧段落，缩短文档还会留下 stale rows。

处置：

- migration `0006_corpus_import_release.sql` 新增 `corpus_import_releases`、`corpus_import_chunks`、guard 与三类 `corpus_release_id`。
- release 状态为 `in_progress`、`ready`、`failed`；Worker 对除 health/me 外的全部 D1 业务路由先检查 current release。
- 91 个 SQL 文件逐一验证名称、SHA-256、bytes，并在成功写入后记录 receipt。
- finalize 同时核对 documents、paragraphs、FTS、page gates、displayed paragraphs、accepted OCR documents、chunk 数、全部 receipt，以及 manifest 指定的 13 项核心表 exact-set。`subjects`、`document_relations`、`chapters`、`version_diffs` 任一非零即在 import start 前 fail-closed；评论、举报、限流和 AI 日志等运行期表不参与 release 计数，也不被清空。
- 旧段落若没有讨论／在线核验引用则删除；有引用的旧段落保留稳定 ID，但强制 `display_allowed=0`、`citation_allowed=0`。这避免 `comments.paragraph_id ON DELETE CASCADE` 导致用户讨论丢失。
- `online_verifications` 自 v4 起显式带 `corpus_release_id` 并按 release 归属计数；`online_evidence` 通过其 verification 的 release 归属计数。构建器不再整表删除核验记录：旧 release 中无段落引用的记录可清理；有段落引用的记录为保全外键证据而保留并关闭引文，其引用的 stale 段落也不得删除。Worker 只读取 current release 的核验记录。
- 每个 paragraph chunk 在 UPSERT 前执行 paragraph reference guard。只要旧段落被 `comments.paragraph_id` 或 `online_verifications.paragraph_id` 引用，`page_number`、`heading`、`source_locator`、`body_sha256`、`provenance_locator` 任一变化都会使原子 batch 失败。guard 只携带哈希与定位字段，不复制正文，避免稳定段落 ID 静默改指另一段文本。
- D1/SQLite 方言验证确认 Wrangler 不接受显式 `BEGIN/COMMIT` 及 `TEMP TABLE`。实现改用 Wrangler 原子多语句 batch 与持久 CHECK guard；失败 batch 不留下 guard 残渣。

当前 corpus manifest：

- schema 1；builder contract `release_snapshot_v4_reference_closure`；release `corpus-f56f6fac3e022bb24ad69265`；fingerprint `f56f6fac3e022bb24ad6926540e780199232c3b7717c454e005437ece864f21d`；
- 196 documents；101 text assets；16,456 paragraphs；16,456 FTS；6,031 page gates；16,456 displayed native paragraphs；0 accepted OCR documents；
- 91 SQL chunks；manifest SHA-256 `5df89703bb875d4e4cf1988a77c5c0a7a8491e0aac5e5da959484e297cbf43b9`。

Manifest 的 13 项 `core_table_counts` 为：

| 核心项 | 精确计数 | 归属口径 |
|---|---:|---|
| `subjects` | 0 | 全局遗留表，必须为空 |
| `periods` | 5 | 全局固定时期维度 |
| `document_relations` | 0 | 全局遗留表，必须为空 |
| `chapters` | 0 | 全局遗留表，必须为空 |
| `document_classifications` | 196 | current `corpus_release_id` 的 documents |
| `document_sources` | 252 | current `corpus_release_id` 的 documents |
| `primary_document_sources` | 196 | current documents 且 `is_primary=1` |
| `subject_insights` | 6 | 本次全量重建的全局集合 |
| `terms` | 5 | 本次全量重建的全局集合 |
| `term_relations` | 4 | 本次全量重建的全局集合 |
| `version_diffs` | 0 | 全局遗留表，必须为空 |
| `online_verifications` | 1 | verification 自身的 current `corpus_release_id` |
| `online_evidence` | 5 | 所属 verification 的 current `corpus_release_id` |

Importer 将该 exact-set 同时写入 `expected_core_counts_json` 与 finalize 后的 `actual_core_counts_json`；Worker 再现场重算 live JSON。expected、actual、live 的键集和值必须完全一致，健康门才可能为 `ready`。

### 4. R2 固定 key 与遗忘发布资产

旧发布器只写六个固定 JSON，新增的页门、语义门、在线核对和资产 registry 可被遗忘；逐 key 覆写也可能让读者看到混合版本。

处置：

- `data/release-assets-policy.json` 枚举 17 个 R2 对象，并覆盖 artifact、catalog、ingest、queue、page/semantic gates、schemas、在线核对、release policy 与采集器生成的环境证据 receipt。
- 每次生成 release manifest，绑定 Git/source tree、资产审计、数据 SHA/bytes/count、两层概念图以及全部 `public ↔ dist` parity。
- 上传路径固定为 `releases/<release_id>/...`；全部不可变对象和完整 manifest readback 通过后，唯一可变写入才是 `release/current.json`。
- Worker 读取 pointer、校验 manifest hash/bytes、定位 `catalog/ingest-manifest.json` 的唯一 versioned object，再校验目标 hash/bytes。pointer 不存在时暂时兼容旧固定 key；pointer 一旦存在但损坏，返回 503，绝不回退旧数据。
- 发布器在 0005、0006 或 versioned reader 未经远端核实时，于任何 R2 mutation 前退出。

### 5. 本地、预览、生产漂移

本轮没有部署。最后已验证外部状态仍为：

- production Worker `7d1766b2-32be-4ce1-9528-f6c69bb2a092`／v7；
- preview Worker `2459045b-9337-477e-af09-571bcd91dcab`／v8；
- 两端 D1 只到 0004；两端 R2 仍使用旧 stable keys；
- 本机为 dirty v9 工作树，包含 0005、0006、corpus gate、versioned reader 与新 release policy。

`data/release-assets-policy.json` 只保存稳定发布要求；`data/release-environment-evidence.json` 保存采集器生成的短期环境快照和命令哈希回执。当前 release manifest 对 preview、production 还会因 0005、0006、`versioned_manifest_v1` reader、Git provenance 或 corpus mismatch 阻断。receipt 必须由新的只读证据更新，不能仅因源码已写好就宣称远端具备能力，也不能手改 policy 或 receipt。

## OCR 质量判断

最新本机状态的 `health.overall=degraded` 只来自一个已隔离页 `legacy-compendium-chemistry:84:paddle`。这不是“全 OCR 失败”，也不能忽略：

- queue 11,847；primary 6,947；pending 4,900；failed/quarantined page 1；
- witness 7,012；completed pages missing witness 0；audit 6,947；stale audit 0；
- manual image review required 783；blank confirmation 73；unresolved fail-closed 6,091；
- reviewed 4，其中 3 页仅获非引文人工图像通过，1 页带警告判断；citation eligible 0。

在线核查只能校正同篇同版；不同版本只能旁证稳定事实。图像与同版文本冲突时以扫描图为准并记录冲突。仍不能确认的内容使用 `human_judgment_with_warning`，继续关闭引文。

## 发布前唯一安全顺序

以下是下一次 preview 窗口的顺序，不是本轮已执行事项：

1. 冻结干净 Git commit，运行完整 `npm run verify`，生成 release manifest；记录 Worker 版本、D1 Time Travel 与旧 R2 pointer。
2. 在 preview 应用 0005、0006；核对 migration list。0006 会为旧数据建立 bootstrap release，确保新版 Worker 首次启动仍有一致快照。
3. 部署新版 preview Worker/Assets。此时 R2 pointer 尚未建立，`/api/source-manifest` 只走兼容读取；health 必须证明 bootstrap corpus ready。
4. 执行 corpus importer。`in_progress` 期间 D1 业务 API 预期返回 503；全部 91 个 receipt 与 finalize 通过后才恢复 200。
5. 运行 `npm run release:evidence:preview`，由远端只读证据采集 0005/0006、`versioned_manifest_v1`、Git 资产 parity、health provenance 与 D1 corpus release；提交并推送 receipt 后重新生成 release manifest。
6. 执行 metadata publisher：不可变 staging → 全对象 readback → manifest readback → 单次 current pointer 切换。
7. 验证 health、meta、搜索、文档详情、source manifest、AI、讨论、真实浏览器、User Center、Nav、Portal、Companion 与 Pulse。
8. 满足 preview 证据后，生产重复同一顺序；不得直接把 preview 数据库、pointer 或环境结论复制成 production 证据。

## 验证命令

```bash
cd /Users/ylsuen/CF/curriculum-atlas
npm run catalog
npm run assets:audit
npm run assets:audit:downloads
npm run corpus:build
npm run concepts:build
npm run concepts:validate
node scripts/validate-online-verification.mjs
npm run build
npm run check
npm test
npm run release:manifest
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
```

本轮还以 Wrangler 4.110.0 的本地 D1 验证 0001–0006 全部可应用、release start 可执行、缺 receipt 的 finalize 会失败，且失败后保持 `in_progress`。

## 回滚边界

- 本轮只改本地源码、生成数据、测试和文档；没有 D1、R2、Worker、Pages 或生产注册写入，因此不需要远端回滚。
- 源码回滚只撤销本轮任务拥有的 registry/audit/release/import/reader/docs hunks；不得 reset、clean 或覆盖同一脏工作树中的既有 OCR、前端和图谱工作。
- 未来 Worker 回滚使用部署前 version；D1 使用发布前 Time Travel；R2 只把 `release/current.json` 原子恢复为已校验的旧 pointer，不删除不可变 release 对象。
- OCR rollback 不删除已通过哈希的原件、primary、Vision、audit 或在线核对证据；只停精确 owner／service 并保留 resume state。

## 剩余阻断

1. preview 与 production 的 0005、0006 尚未应用。
2. preview 与 production Worker 尚未核实 versioned pointer reader。
3. 当前 Git 工作树很脏，不能作为单一可回滚发布提交。
4. 4,900 页主 OCR 未完成；6,091 页已审计但语义仍未解决；783 页需图像复核；73 页需空白确认；1 页隔离。
5. OCR accepted documents/pages 均为 0，因此 OCR 结果尚未接入公开正文、AI 引文或正式概念关系。
6. 两个 derived PDF 的变换谱系不完整；继续阻断。
7. 全学科深层 ontology 尚未完成；当前 169 节点主要属于语文，不能伪报全科精细模型完成。
8. 最后一次 DMITPro2 远端 OCR 核验是带时间戳快照；后续刷新因非交互 key 未能进入内层机，故本报告不虚构更新远端进度。
