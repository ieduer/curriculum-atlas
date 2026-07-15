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
