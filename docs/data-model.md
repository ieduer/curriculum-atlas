# 数据模型

D1 的规范结构由 `migrations/0001_initial.sql`、`0002_source_provenance_and_ocr_quality.sql` 与 `0003_online_verification.sql` 定义。

## 主要实体

| 类别 | 主要表 | 用途 |
|---|---|---|
| 文件与版本 | `documents`, `document_relations`, `periods` | 文件身份、状态、历史阶段与继承/修订/替代关系 |
| 原文与检索 | `paragraphs`, `paragraphs_fts` | 章节、段落锚点、质量状态与 FTS5 索引 |
| 分析结构 | `concepts`, `document_concepts`, `cross_subject_relations` | 术语、理念和跨学科证据关系 |
| OCR 溯源 | `source_artifacts`, `ocr_runs`, `ocr_page_reviews` | 源哈希、引擎版本、页级结果和复核状态 |
| 在线核查 | `online_verifications`, `online_evidence` | 篇目身份、版次、权威在线证据、冲突与裁决 |
| 讨论 | `comments`, `comment_reports` | 版本绑定评论、回复、举报和审核状态 |
| AI 审计 | `ai_citation_logs` | 模型标签、检索段落、引文状态与生成时间 |

## 引文闸门

检索和 AI 必须同时满足 `documents.citation_allowed=1` 与 `paragraphs.citation_allowed=1`。OCR 完成不是开放条件；版本身份、页级质量与在线核查仍需独立通过。抽样核验不得提升整份文档。

## 标识稳定性

文件 slug、版本关系、段落 ID 和评论目标是外部引用的一部分。更新内容时使用 upsert，禁止会导致评论级联丢失的 `INSERT OR REPLACE INTO documents`。源文件变更后必须重算 SHA-256，旧页的通过状态不得继承。

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
