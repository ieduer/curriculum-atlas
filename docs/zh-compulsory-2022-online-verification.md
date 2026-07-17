# 义务教育语文 2022 在线核对层

本目录中的 `data/online-verification/zh-compulsory-2022-claims.json` 是一个独立、只读、fail-closed 的核对 artifact。它用于记录《义务教育语文课程标准（2022年版）》中版本敏感表述的“原页图像—OCR—在线文本”交叉结果，不是候选概念层、ontology、builder 输入、公开数据或发布门禁。

## 文献身份

- 文献：`moe-2022-03`，《义务教育语文课程标准（2022年版）》
- 教育部 PDF SHA-256：`3ef0ec8a30b5a950211202658df07d99f5427f750f8ba0c3cfda12736b7bd71a`
- 课程教材研究所 PDF 与教育部 PDF 的 SHA-256 相同，只标记为 `same_artifact_mirror`，独立证据增量为 `0`
- 所有 source、claim、冲突和版本隔离记录均为 `publication_unlock: false`

## 核对结论

| Claim | 状态 | 核对边界 |
| --- | --- | --- |
| 四项核心素养 | `independently_crosschecked` | 文化自信、语言运用、思维能力、审美创造 |
| 四类语文实践 | `independently_crosschecked` | 识字与写字、阅读与鉴赏、表达与交流、梳理与探究 |
| “分三个层面设置学习任务群”（共六个任务群） | `independently_crosschecked` | 保留“基础型 1、发展型 3、拓展型 2”，六群为同类并列实体；“三层六任务群”只作检索简称 |
| 四个学业质量学段 | `independently_crosschecked` | 六三学制四学段是年级范围，不是质量等级 |
| 三类学业质量情境 | `independently_crosschecked` | 日常生活、文学体验、跨学科学习；同名任务群与情境不可合并 |
| 九条课程总目标 | `partial_conflicted` | 缺少第二份完整、权威、无冲突的独立在线转录；第六条在线误录已显式隔离 |

“总目标 → 核心素养”的分组只保留为 `interpretive_nonexclusive`，并强制 `normative: false`、`semantic_relation_allowed: false`。2025 日常修订版、高中语文标准和盲校语文标准分别按版本、教育阶段和学校类型错配隔离，禁止用于 2022 年版逐字裁决、概念身份合并或发布放行。

## OCR 冲突裁决

已定位的五处问题全部记录为 `source_image_wins`、`human_verified`：

1. `以生活基础` → `以生活为基础`
2. `以学习任务载体` → `以学习任务为载体`
3. `感受多样化` → `感受多样文化`
4. `提升形象思维能力` → `提高形象思维能力`
5. `核心素养评价提供基本依据` → `为核心素养评价提供基本依据`

在线文本只作为独立交叉或冲突见证。发生版本不一致、同物理制品镜像、在线转录冲突或只支持局部条目时，不能覆盖原页图像。

## 验证

```bash
node scripts/validate-zh-compulsory-2022-online-verification.mjs
node --test tests/zh-compulsory-2022-online-verification.test.mjs
```

校验器同时执行 JSON Schema 子集验证与本任务的强语义不变量；任何 claim 解锁、镜像证据膨胀、已知错字回流、版本隔离移除、解释性映射规范化或图像裁决弱化都会失败。
