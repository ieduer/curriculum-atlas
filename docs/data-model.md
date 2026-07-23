# 数据模型

D1 的规范结构由 `migrations/0001_initial.sql` 至 `0007_document_taxonomy_contract.sql` 顺序定义。Preview 与 production 均已应用 `0001`–`0007`；当前 Worker v10 health 合同为全局 schema 3、taxonomy schema 2、page publication schema 1。

## 主要实体

| 类别 | 主要表 | 用途 |
|---|---|---|
| 文件与版本 | `documents`, `document_relations`, `periods` | 文件身份、状态、历史阶段与继承/修订/替代关系 |
| 原文与检索 | `paragraphs`, `paragraphs_fts` | 章节、段落锚点、质量状态与 FTS5 索引 |
| 分析结构 | `concepts`, `document_concepts`, `cross_subject_relations` | 术语、理念和跨学科证据关系 |
| OCR 溯源 | `source_artifacts`, `ocr_runs`, `ocr_page_reviews` | 源哈希、引擎版本、页级结果和复核状态 |
| 在线核查 | `online_verifications`, `online_evidence` | 篇目身份、版次、权威在线证据、冲突与裁决 |
| 页级发布 | `page_publication_gates` | 源页、最终文本、证据 bundle、显示与引文的独立门 |
| Corpus release | `corpus_import_releases`, `corpus_import_chunks`, `corpus_import_guards` | 整批状态、预期/实际计数、SQL 分块哈希与回执 |
| 学术身份与展示 | `document_classifications` | `taxonomy_entity_kind`、精确普通学科身份、12 个展示分面，以及课程/范围隔离 |
| 讨论 | `comments`, `comment_reports` | 版本绑定评论、回复、举报和审核状态 |
| AI 审计 | `ai_citation_logs` | 模型标签、检索段落、引文状态与生成时间 |

## Taxonomy schema 2

`document_classifications.entity_kind` 保留旧 `subject` / `scope` 兼容层；规范身份由 `taxonomy_entity_kind` 决定：

- `subject`：159 份资料，28 个精确普通学科 query identities，可映射至 12 个 `display_facet`；
- `assessment_subject`：1 份“汉语”考试身份，关联语文 facet，但不进入普通 `subject=汉语` 查询；
- `curriculum_course`：16 份课程，`canonical_subject` 与 `display_facet` 均为 `null`；
- `assessment_domain` 3、`source_collection` 4、`cross_cutting_framework` 13，共 20 scope；
- `unclassified`：0。

公开 12 facets 为：语文、数学、外语、思想政治与道德法治、历史、历史与社会、地理、科学类、技术、劳动、艺术、体育与健康。Facet 是展示聚合，不覆盖原始来源标签、精确学科 identity、官方 code 或课程身份。普通 subject filter 只允许 `taxonomy_entity_kind='subject'`；assessment/course/scope 通过独立元数据和详情呈现。

## 引文闸门

检索和 AI 必须同时满足 `documents.citation_allowed=1` 与 `paragraphs.citation_allowed=1`。OCR 完成不是开放条件；版本身份、页级质量与在线核查仍需独立通过。抽样核验不得提升整份文档。

## 标识稳定性

文件 slug、版本关系、段落 ID 和评论目标是外部引用的一部分。更新内容时使用 upsert，禁止会导致评论级联丢失的 `INSERT OR REPLACE INTO documents`。源文件变更后必须重算 SHA-256，旧页的通过状态不得继承。

## Corpus release 一致性

每次 `npm run corpus:build` 生成一个由 catalog、ingest、来源、分类、在线核验、语义策略和实际正文资产共同决定的 release fingerprint。当前 manifest 逐一登记正文 SHA-256/bytes 及所有 SQL chunk 的名称、SHA-256/bytes。

当前 release 为 `corpus-358471fcce862b2f0ae446fc`，fingerprint SHA-256 `358471fcce862b2f0ae446fcae834db80b24b8d5c0e8dcbfd3c9f5a1ae0d2c70`，manifest SHA-256 `87aa26a4975ee39e4c5f104159367a7528167515c4a10bc287447f7bdd69e0a3`。Preview 与 production 均已通过 91/91 远端 receipt 的 name/hash/bytes 核对并 finalize 为 `ready`。

导入时先写 `in_progress`，逐 chunk 写 receipt；只有 documents、paragraphs、FTS、page gates、displayed rows、accepted OCR documents 和 receipt 全部精确匹配才可写 `ready`。Worker 在 release 缺失、非 ready 或实时计数漂移时，对 D1 业务路由返回 503。

当前精确计数顺序为：196 documents / 16,456 paragraphs / 16,456 FTS rows / 6,031 page gates / 16,456 displayed paragraphs / 0 accepted OCR documents / 91 chunks。不要把 FTS 与 page-gate 数量互换，也不要从 OCR 机器进度推断 accepted OCR。

新 release 缩短文档时，未被引用的旧段落可删除；被讨论或在线核验引用的旧段落保留稳定 ID，但关闭 display/citation。这样既清除 stale search rows，又避免评论级联删除。

## R2 release identity

R2 不是 D1 的来源真相，只保存可公开重建的质量元数据。每个对象发布到 `releases/<release_id>/...`，完整 manifest 与对象 hash/bytes readback 通过后，才原子更新 `release/current.json`。Worker 若看到 pointer，就必须完整验证 pointer、manifest 与目标对象；pointer 损坏时不允许回退旧 fixed key。

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
| `works` | 一个目录文档或一个内嵌页片段 | 当前采用 `document_scoped_not_deduplicated`，不自动判定同一作品 |
| `editions`, `revisions` | 文档版次与显式修订事件 | “2017年版2020年修订”分别保存基础版年和修订年；生效日期未知时为 `null` |
| `embedded_items` | 一张已定位的汇编页片段 | 不把相邻页静默合并成完整篇目，完整性恒为 false |
| `occurrences` | 一次精确词面命中 | 保存词形、义项、版本、页/段、起止偏移、复用簇；章节和规范角色未知时为 `unknown`/`null` |
| `relations`, `relation_reviews` | 两个 episode 之间的关系及其审核状态 | 自动关系只允许非语义 `next_observed`、`co_observed`，两端均须有证据，不允许影响/因果结论 |
| `coverage_cells` | 一个版次或页片段的覆盖单元 | 显式保存分母、缺口和引文闸门；`negative_claim_eligible=false` |
| `editorial_audit` | 一项构建或主张政策 | 保存机器生成边界与尚未发生的编辑审核，不伪造审核者和时间 |

完整约束和学科分类决定见 `docs/concept-evolution-academic-model.md`。

## 百年 OCR 候选星投影

`data/embedded-items-century-v1.json` 保存语文卷与课程计划卷目录解析出的 134 个内嵌篇目。它们是文档级证据容器，不是星体。`scripts/build-century-observation-layer.mjs` 从页级 OCR 候选生成 `public/data/century-observation-layer.json`，其中：

- `items` 保存 1902–2000 的篇目身份、年份与物理页段；
- `concept_observations` 保存受控词面命中，恒为 `ocr_surface_candidate_nonsemantic`；
- `star_projection.episodes` 把每次词面观察映射为同一主星图中的虚线候选星；
- `star_projection.evidence` 把候选星反向定位到篇目和扫描物理页；
- `star_projection.edges` 只允许同源顺序或同篇共现关系，禁止语义、影响和因果主张。

必须满足一星至少一证据定位、边的两端均存在、所有候选均 `citation_allowed=false`。OCR 队列可以连续追加页面和观察，但不得因此改写现行概念模型或自动开放检索/AI 引文。
