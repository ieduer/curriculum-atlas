# 2022 义务教育语文概念候选层

`data/ontology-candidates/zh-compulsory-2022.json` 是独立、版本隔离、默认关闭的研究候选层。它绑定教育部普通义务教育语文 2022 年版原始 PDF：

- 文档：`moe-2022-03`
- SHA-256：`3ef0ec8a30b5a950211202658df07d99f5427f750f8ba0c3cfda12736b7bd71a`
- 物理页数：109
- 学校类型：普通教育，不含盲校或其他特殊教育版本
- 学段：义务教育，不含普通高中版本

## 候选规模

- M0：43 个节点。根 1；核心素养 5；总目标 10；语文实践 5；主题载体 4；学习任务群 10；学业质量 8。
- M1：新增 21 个节点。学段要求框架 1；第一至第四学段 4；四学段乘四实践领域要求簇 16。累计 64。

## 强制边界

- 所有节点 `citation_allowed=false`。
- 所有父子关系和编辑对齐 `semantic_relation_allowed=false`。
- 所有对象 `publication_status=candidate_fail_closed`。
- 不修改 `data/concept-ontology.json`、概念图生成器、公开数据、发布门禁或部署。
- 九项总目标不自动映射到四个核心素养维度。
- 学习任务群“跨学科学习”和学业质量“跨学科学习情境”是两个不同节点。
- 第一至第四学段学业质量不是高中“水平一至水平五”。
- “语言运用”不复用高中“语言文字运用”的 `language-use` 词义。
- 四学段乘四实践领域要求簇是编辑建模，关系均标记 `reviewed_inference`。

## 证据门禁

每个页锚点都保留原图、OCR 加独立见证、同版在线文本和版本身份状态。当前仅确认同版官方原始文件身份；独立在线正文核对与逐页原图审查未完成，因此所有锚点总体状态均为 `blocked`。

物理页 75 与 109 已由语义发布策略预先阻断，分别要求 `row_alignment_verified` 与 `running_header_removed`，不得作为本候选层证据。

验证：

```bash
node scripts/validate-ontology-candidate-layer.mjs \
  --source .cache/sources/moe-2022-03.pdf

node --test tests/ontology-candidate-layer.test.mjs
```
