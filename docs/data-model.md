# 数据模型

D1 的线上规范结构目前由 `migrations/0001_initial.sql` 至 `0007_document_taxonomy_contract.sql` 顺序定义。Preview 与 production 均只确认应用 `0001`–`0007`；本地候选按序新增 `0008_release_ownership_fences.sql` 与 `0009_compendium_embedded_items.sql`，尚未应用、尚未上线，不得从源代码存在推断线上已有 fence 或篇目表。当前 Worker v10 health 合同仍为全局 schema 3、taxonomy schema 2、page publication schema 1。

## 主要实体

| 类别 | 主要表 | 用途 |
|---|---|---|
| 文件与版本 | `documents`, `document_relations`, `periods` | 文件身份、状态、历史阶段与继承/修订/替代关系 |
| 原文与检索 | `paragraphs`, `paragraphs_fts` | 章节、段落锚点、质量状态与 FTS5 索引 |
| 分析结构 | `concepts`, `document_concepts`, `cross_subject_relations` | 术语、理念和跨学科证据关系 |
| OCR 溯源 | `source_artifacts`, `ocr_runs`, `ocr_page_reviews` | 源哈希、引擎版本、页级结果和复核状态 |
| 在线核查 | `online_verifications`, `online_evidence` | 篇目身份、版次、权威在线证据、冲突与裁决 |
| 页级发布 | `page_publication_gates` | 源页、最终文本、证据 bundle、显示与引文的独立门 |
| 汇编篇目（待 `0009`） | `embedded_items` | 卷内独立篇目身份、稳定目录证据 ID、页范围、在线同版核对与墓碑状态 |
| Corpus release | `corpus_import_releases`, `corpus_import_chunks`, `corpus_import_guards` | 整批状态、预期/实际计数、SQL 分块哈希与回执 |
| 学术身份与展示 | `document_classifications` | `taxonomy_entity_kind`、精确普通学科身份、12 个展示分面，以及课程/范围隔离 |
| 讨论 | `comments`, `comment_reports` | 版本绑定评论、回复、举报和审核状态 |
| AI 审计 | `ai_citation_logs` | 模型标签、检索段落、引文状态与生成时间 |

## Taxonomy schema 2

`document_classifications.entity_kind` 保留旧 `subject` / `scope` 兼容层；规范身份由 `taxonomy_entity_kind` 决定：

- `subject`：158 份普通学科资料，28 个精确普通学科 query identities，可映射至 12 个 `display_facet`；
- `assessment_subject`：1 份“汉语”考试身份，关联语文 facet，但不进入普通 `subject=汉语` 查询；
- `curriculum_course`：16 份课程，`canonical_subject` 与 `display_facet` 均为 `null`；
- `assessment_domain` 3、`source_collection` 4、`cross_cutting_framework` 13，共 20 scope；
- `unclassified`：0。

同一作品的不同扫描件不再各占一个 `documents` 身份。已核验的 2011 年初中科学教育部 89 页发布件使用 `moe-2011-12` 作为唯一作品/版本身份；ICTR 88 页扫描件通过 `document_sources.artifact_disposition='variant'` 与 `artifact-registry` 的 `same_edition_cross_validation_scan` 关系保留，只用于页序、图像与 OCR 交叉核对，不进入第二次 OCR 或版本比较。

公开 12 facets 为：语文、数学、外语、思想政治与道德法治、历史、历史与社会、地理、科学类、技术、劳动、艺术、体育与健康。Facet 是展示聚合，不覆盖原始来源标签、精确学科 identity、官方 code 或课程身份。普通 subject filter 只允许 `taxonomy_entity_kind='subject'`；assessment/course/scope 通过独立元数据和详情呈现。

## 引文闸门

检索和 AI 的有效引文门按身份类型计算，且两类都必须先满足 `paragraphs.citation_allowed=1` 与对应 `page_publication_gates.citation_allowed=1`：

- 普通文档段落：再要求 `documents.citation_allowed=1`；
- 汇编篇目段落：再要求当前 release 的 `embedded_items.citation_allowed=1`，父载体文档的引文位不参与替代；
- 页为 0 / 篇目为 1，或页为 1 / 篇目为 0 / 父文档为 1，均必须 fail closed。

Builder、D1 finalizer 与 Worker retrieval 使用同一真值规则。`all_pages_citation_verified` 的含义是篇目范围内每一物理页都为 citation-allowed，不能由篇目级 entitlement 反向抬高页级状态。OCR 完成不是开放条件；版本身份、页级质量与在线核查仍需独立通过。

## 标识稳定性

文件 slug、版本关系、段落 ID 和评论目标是外部引用的一部分。汇编篇目 ID 由父文档 ID、源文件 SHA-256 与不可变 TOC entry receipt 派生；`sequence` 只负责排序，插入或重排目录行不能改变其他篇目 ID。更新内容时使用 upsert，禁止会导致评论级联丢失的 `INSERT OR REPLACE INTO documents`。源文件变更后必须重算 SHA-256，旧页的通过状态不得继承。

## Corpus release 一致性

每次 `npm run corpus:build` 生成一个由 catalog、ingest、来源、分类、在线核验、语义策略和实际正文资产共同决定的 release fingerprint。当前 manifest 逐一登记正文 SHA-256/bytes 及所有 SQL chunk 的名称、SHA-256/bytes。

当前 release 为 `corpus-358471fcce862b2f0ae446fc`，fingerprint SHA-256 `358471fcce862b2f0ae446fcae834db80b24b8d5c0e8dcbfd3c9f5a1ae0d2c70`，manifest SHA-256 `87aa26a4975ee39e4c5f104159367a7528167515c4a10bc287447f7bdd69e0a3`。Preview 与 production 均已通过 91/91 远端 receipt 的 name/hash/bytes 核对并 finalize 为 `ready`。

导入时先写 `in_progress`，逐 chunk 写 receipt；只有 documents、paragraphs、FTS、page gates、displayed rows、accepted OCR documents 和 receipt 全部精确匹配才可写 `ready`。Worker 在 release 缺失、非 ready 或实时计数漂移时，对 D1 业务路由返回 503。

当前精确计数顺序为：196 documents / 16,456 paragraphs / 16,456 FTS rows / 6,031 page gates / 16,456 displayed paragraphs / 0 accepted OCR documents / 91 chunks。不要把 FTS 与 page-gate 数量互换，也不要从 OCR 机器进度推断 accepted OCR。

新 release 缩短文档时，未被引用的旧段落可删除；被讨论或在线核验引用的旧段落保留稳定 ID，但关闭 display/citation。这样既清除 stale search rows，又避免评论级联删除。

`0009` 的篇目退役规则同样 fail closed：被评论或保留段落引用的旧篇目转为 `closed_tombstone`，关闭 display/citation/semantic 并保留外键；无任何引用的旧篇目才可删除。公共 current 查询同时绑定 `current_corpus_release_id`，因此墓碑不混入当前资料、检索或讨论列表，但旧评论和外键身份不会因一次 corpus rebuild 漂移。`UNIQUE(parent_document_id, corpus_release_id, sequence)` 允许同一载体的新 release 与旧墓碑并存。

`GET /api/documents` 的候选合同返回 `{documents,total,hasMore,cursor}`，排序末键固定为 `id`。Cursor 绑定 current corpus release 与完整筛选条件；版本或筛选漂移返回 409。前端必须沿不透明 cursor 拉至 `hasMore=false` 并校验总数、重复 ID 与游标前进；不能把单页 `limit=200` 当作完整身份集。讨论接口保留 `parent_id`，前端以 `parentId` 提交回复并按父子关系显示层级。

## R2 release identity

R2 不是 D1 的来源真相，只保存可公开重建的质量元数据。每个对象发布到 `releases/<release_id>/...`；publisher 先取得环境 D1 的 cooperative single-writer lease，从私有只读快照写入并完成 manifest 与对象 hash/bytes readback，随后再次核对同一 predecessor pointer 的原始 bytes，才更新 `release/current.json`。同一 release id 的 immutable manifest 使用不含观测时间的稳定投影，已有 key 若非逐字节相同必须拒绝而非覆盖。Worker 若看到 pointer，就必须完整验证 pointer、manifest 与目标对象；pointer 损坏时不允许回退旧 fixed key。

Production current 为 `release-9cb02f77c06ee0535e7981a22b312373`；preview current 为 `release-841a528f0086ce69f2f7a6f2d07c0999`。`data/release-environment-evidence.json` 保存采集时的 pointer snapshot：production 首次 bootstrap 与 preview successor activation 都发生在 evidence 之后，因此当前 R2 identity 必须结合 append-only post-activation readback，而不能只读 evidence 内的旧 pointer 字段。

## 公共概念图 v2

`public/data/concept-evolution.json` 保留 `schema_version=1` 作为轻量前端传输外壳，仅含 episode、edge 和每个 episode 一条证据预览，并通过 `academic_model_ref` 指向完整的 `public/data/concept-evolution-academic.json`。两文件共享 `build_revision`，core 保存完整文件 SHA-256；研究与校验使用 academic 文件中的以下规范实体：

| 实体 | 粒度 | 主要边界 |
|---|---|---|
| `subject_taxonomy`, `subject_entity_audit`, `subject_facets` | 来源标签、目录文件、星图展示组 | 原始 `subject` 不直接成为筛选项；受控 `subject`/`assessment_subject` 保留精确 canonical/stable ID/code，再唯一映射至 12 个展示 facet；`curriculum_course` 另存课程实体且不进入展示组 |
| `course_families`, `course_to_subject_links`, `course_entity` | 课程族、课程与学科关联、episode 课程身份 | 关联不等于合并；课程保持 `facet_eligible=false`，兼容 `scope_entity` 时仍须有显式 `course_entity` |
| `concept_senses` | 一个尚未分义的概念种子 | 编辑分义前每个 concept 仅有一个 `undifferentiated_unresolved` sense；学科/版本语境留在 occurrence/episode |
| `surface_forms` | 一个可检索词形 | 正字/词汇变体可自动匹配；历史相关或语义相关形式默认关闭自动匹配 |
| `curriculum_lines` | 学科、学段、学校类型/子类、文件类型、发布机构 | 盲校、聋校、培智与普通教育不得合并 |
| `works` | 一个目录文档或一个已核完整汇编篇目 | 目录文档采用 `document_scoped_not_deduplicated`；汇编篇目只有在完整边界门通过后才建立独立 work |
| `editions`, `revisions` | 文档版次与显式修订事件 | “2017年版2020年修订”分别保存基础版年和修订年；生效日期未知时为 `null` |
| `embedded_items` | 一个完整、逐页放行的汇编篇目 | 目录只生成候选；正文标题、下一篇标题或卷末、全部页证据和当前 corpus release 均绑定后才显示；同篇同版在线全文核对后才可引文 |
| `occurrences` | 一次精确词面命中 | 保存词形、义项、版本、页/段、起止偏移、复用簇；章节和规范角色未知时为 `unknown`/`null` |
| `relations`, `relation_reviews` | 两个 episode 之间的关系及其审核状态 | 自动关系只允许非语义 `next_observed`、`co_observed`，两端均须有证据，不允许影响/因果结论 |
| `coverage_cells` | 一个版次或完整汇编篇目的覆盖单元 | 显式保存分母、页数、缺口和引文闸门；只有完整篇目可 `complete=true`，但 `negative_claim_eligible` 仍固定为 false |
| `editorial_audit` | 一项构建或主张政策 | 保存机器生成边界与尚未发生的编辑审核，不伪造审核者和时间 |

完整约束和学科分类决定见 `docs/concept-evolution-academic-model.md`。
