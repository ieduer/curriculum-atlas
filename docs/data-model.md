# 数据模型

D1 规范结构由 `migrations/0001_initial.sql` 至 `0007_document_taxonomy_contract.sql` 顺序定义。Preview 与 production 均已应用 `0001`–`0007`；当前 Worker `2026.07.24-v18` health 合同为全局 schema 3、taxonomy schema 2、page-publication schema 1。

## 主要实体

| 类别 | 主要表 | 用途 |
|---|---|---|
| 文件与版本 | `documents`, `document_relations`, `periods` | 文件身份、状态、历史阶段与继承/修订/替代关系 |
| 原文与检索 | `paragraphs`, `paragraphs_fts` | 章节、段落锚点、质量状态与 FTS5 索引 |
| 分析结构 | `concepts`, `document_concepts`, `cross_subject_relations` | 术语、理念和跨学科证据关系 |
| OCR 溯源 | `source_artifacts`, `ocr_runs`, `ocr_page_reviews` | 源哈希、引擎版本、页级结果和机器裁决状态 |
| 在线核查 | `online_verifications`, `online_evidence` | 篇目身份、版次、权威在线证据与冲突记录 |
| 页级发布 | `page_publication_gates` | 源页、最终文本、证据 bundle、显示与引文的独立门 |
| Corpus release | `corpus_import_releases`, `corpus_import_chunks`, `corpus_import_guards` | 整批状态、预期/实际计数、SQL 分块哈希与回执 |
| 学术身份与展示 | `document_classifications` | 精确学科身份、12 个存储分面、课程/范围隔离 |
| 讨论 | `comments`, `comment_reports` | 版本绑定评论、回复、举报和审核状态 |
| AI 审计 | `ai_citation_logs` | 模型标签、检索段落、引文状态与生成时间 |

## Taxonomy schema 2

`taxonomy_entity_kind` 是规范身份：

- `subject`：159 份资料，映射至 12 个存储分面；
- `assessment_subject`：1 份“汉语”考试身份，关联语文但不进入普通 `subject=汉语` 查询；
- `curriculum_course`：16 份课程，不伪装成普通学科；
- `assessment_domain` 3、`source_collection` 4、`cross_cutting_framework` 13，共 20 scope；
- `unclassified`：0。

存储层保留“历史”与“历史与社会”两种来源身份；公开检索统一为“历史”一个分面，但不把两种身份判为语义等同。`discipline-lifecycle.json` v2 以 11 条公开学科百年链为主结构，每条链解析一个或多个 `subject-course-identity` 家族并到达 2022；9 个合科、分科、并行发标、独立设置和国家标准组调整事件作为来源明示里程碑挂接。语文链另保留 1902 年课程表「作文」的 `parallel_course_form` 候选观察，但不把后世作文实践词面改判为课程更名。

## OCR 四层状态

1. **机器裁决**：`data/ocr-machine-verification.json` 保存 6,947 页的不可变终局收据。31 exact 可进入下一阶段；5,063 文字冲突、1,780 表格冲突、73 双空白全部终局关闭。
2. **页级发布**：`data/ocr-publication-receipt.json` 重新读取来源、页图与文本并复算哈希，31 exact receipts 去重为 30 个唯一页，写入 `data/page-publication-manifest.json`。
3. **Corpus 检索**：30 页形成 26 个 accepted OCR documents、44 个 paragraph candidates；只有文档与段落双白名单同时为真时才能检索或引用。
4. **候选星图**：`public/data/ocr-observation-layer.json` 从 83 份完整文件／10,210 页生成 308 个词面观察。它与正式引文无继承关系，恒为 nonsemantic、noncitable。

机器裁决收据的 `production_citation_ready_pages=0` 只描述第一阶段未写 manifest 的时点；当前发布真相必须读取第二、三阶段的哈希绑定收据，不能把阶段字段当成同一口径。

## Corpus release 一致性

当前 release：

- ID：`corpus-1c4f6b41737380f3e71246dd`
- fingerprint：`1c4f6b41737380f3e71246dd6891914009633b454b6ec716d379e04df3e6d2ca`
- manifest SHA-256：`13341b79d4e5aa080fe9c1514fb2eee826887146ae0f8e7f2909c394b28d0764`
- 精确计数：196 documents / 16,500 paragraphs / 16,500 FTS / 8,808 page gates / 16,500 displayed / 26 accepted OCR documents / 103 chunks。

Importer 先写 `in_progress`，逐 chunk 保存 name/hash/bytes receipt；只有上述总量和 13 个 core-table counts 全部精确匹配才写 `ready`。Worker 在 release 缺失、非 ready 或实时计数漂移时，对 D1 业务路由 fail closed 503。

新 release 缩短文档时，未被引用的旧段落可删除；被讨论或在线核验引用的旧段落保留稳定 ID，但关闭 display/citation。禁止使用会导致评论级联丢失的 `INSERT OR REPLACE INTO documents`。

## 公共概念图与传输

完整学术模型包含 `concept_senses`、`surface_forms`、`curriculum_lines`、`works`、`editions`、`revisions`、`embedded_items`、`occurrences`、`relations`、`coverage_cells` 与 ontology。未获得定义证据前，每个 concept 只有一个 `undifferentiated_unresolved` sense；学科/版本语境留在 occurrence/episode，不能凭词面自动分义。

浏览器不直接传输 23 MB 单文件。`public/data/concept-evolution-academic.json` 是 30,220-byte 索引，指向 `public/data/graph-shards/academic/` 下 64 个内容寻址分片；最大 524,250 bytes、总计 23,208,620 bytes。`scripts/academic-graph-shards.mjs` 必须验证每片 SHA-256、bytes、build revision、collection、chunk、计数并重建与原模型逐字段相同的对象。核心前端图不分片，仍由 `public/data/concept-evolution.json` 直接加载。

前端在同一 Canvas 合并：

| 层 | Episodes | Evidence | Edges | 发布边界 |
|---|---:|---:|---:|---|
| core 正式概念图 | 553 | 553 | 475 | 受现有证据状态约束 |
| 1902–2022 century layer | 1,031 | 3,202 | 1,107 | 候选、nonsemantic |
| 现行学科细层 | 97 | 420 | 0 | 候选、nonsemantic |
| 2001 年前专科层 | 426 | 821 | 0 | 候选、nonsemantic |
| 完整 OCR 通用层 | 308 | 308 | 214 | 候选、nonsemantic |
| **合并总计** | **2,415** | **5,304** | **3,144** | 单一 Canvas |

## 2001 年前与概念族

- `data/embedded-items-century-v1.json` 保留语文卷／课程计划卷 134 个来源篇目，产生 1,031 个 century stars。
- `data/pre2001-specialist-bounded-items.json` 扩展至各科专科汇编；462/462 item identities 通过，生成 426 个同粒度星点。
- `public/data/concept-evolution-families.json` 固定 5 个同层 tier、55 个互斥比较族、1,648 memberships、1,251 同词面边、94 编辑对应边和 3 条有来源的学科分合边。
- 每条族谱边恒为 `semantic=false`、`citation_allowed=false`、`influence_claim_allowed=false`。点击成员时可以整族高亮和缩放，但不能据此声称首次出现、消失、替代、等同或因果。

## R2 release identity

R2 只保存可公开重建的质量元数据。发布顺序固定为 17 个 `releases/<release_id>/...` immutable objects → 逐对象 readback → versioned manifest/readback → 原子更新 `release/current.json` → pointer readback。

当前 preview 与 production release ID 均为 `release-cd9ec4a050cbabbede744192398ebfa7`。两桶的 manifest 包含各自采集时环境快照，所以 SHA-256 不同但 release-managed object identity 相同：

- preview：`9e964d6c8e3898dcb8078e4f0b5b8780cd3379e566abff8c12efc5b84ee63bc1`，188,566 bytes；
- production：`7b2b836ae29c98743b3a3248eac8e013a4b6c048ac473b0c95685804fb365018`，188,566 bytes。

Environment evidence 是采集时快照；随后发生的 pointer 激活由 append-only action-log readback 证明，不能回写伪造采集时间。

## 私有百年原页阅读层

1902–2000 目录的 462 个来源身份按 `source_item_id || id` 去重为 461 个阅读身份；唯一共用页段只生成一个物理包并保留两个公开分面。每个包由 4-byte header 长度、JSON header 和单条 PDF 页片段组成，header 保存逐页 OCR 候选及其 hash。当前固定计数为 461 个 item、4,604 个 bounded page instances。

发布契约：

- `historical-reader/releases/<release_id>/items/<sha256(item_id)>.bin` 为 immutable object；
- manifest 精确列出 461 个 item 的 object/header/PDF hash 与 bytes；
- 所有对象上传并逐一 readback 后，才切换 `historical-reader/current.json`；
- Worker 在返回内容前复核 pointer → manifest → item → header → PDF 全链；
- 匿名请求不得读取 R2；登录响应使用 `private, no-store` 与 `noindex, noarchive`；
- OCR 文字恒为 candidate、`citation_allowed=false`、`semantic_claim_allowed=false`，不进入 D1 正式全文检索与证据 AI。
