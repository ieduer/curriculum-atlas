# 概念演进学术数据模型 v2

## 目的与断言边界

星图研究对象不是一份份课标，而是各学科课标中关键概念的词面出现、课程线定位、版次证据与可审核关系。当前自动产物只证明“在当前可用文本的这个位置观察到这个受控词形”；它不证明概念义项连续、正式定义、首次出现、消失、改名、取代、影响或因果演进。

轻量 `concept-evolution.json` 为兼容前端保留 `schema_version=1`，完整 `concept-evolution-academic.json` 使用 `schema_version=2`。core 通过带 SHA-256 和计数的 `academic_model_ref` 指向完整模型，目标小于 4 MiB；任何消费研究实体的新代码应按需加载后者。

## 实体链

```text
subject/course taxonomy ─┐
concept sense ────┼─> occurrence ─> evidence ─> episode ─> relation/review
surface form ─────┤       │                        │
curriculum line ──┤       └─ text reuse cluster   └─ coverage cell
work/edition ─────┘
```

- 编辑分义前每个 concept 只有一个 `undifferentiated_unresolved` sense；定义、有效期和上下位关系保持 `null`/空数组，学科语境留在 occurrence/episode。只有定义证据或人工审核确认实际语义差异后才拆分 sense。
- `surface_form` 区分 canonical、正字变体、缩略、扩展词形、历史相关形式和语义相关形式。后两类不得自动匹配。
- `work` 当前按目录文档隔离，不自动去重；`edition` 与 `revision` 分开。版次无法证明时不合并。
- 历史汇编只按已定位物理页建立 `embedded_item`，不把一页冒充完整篇目。
- `occurrence` 是一次有起止偏移的精确词面命中；章节路径、标题、规范角色没有解析证据时分别为 `null`/`unknown`。
- `relation` 必须有两端证据和 `relation_review`。自动关系一律 `semantic=false`、`influence_claim_allowed=false`。

## 语文多层概念本体

`data/concept-ontology.json` 是独立于词面观察图的编辑审核层。词面图回答“某个受控词形在何处出现”，本体回答“在某个明确版次中，教师可以沿哪些课程结构继续向下探查”。两层不得互相冒充：自动命中、课程的 `related_subjects` 和同名词都不能自动取得语义身份。

首批语文本体含 76 个节点、3 个严格版本范围、14 个官方可引文证据锚点和 7 条经审核的非树状语义关系；再加父子结构后，发布图共有 82 条本体关系。当前可下钻结构为：

- “语言文字运用”下展开听、说、读、写、文学活动；
- 历史“三维目标”下展开知识与能力、过程与方法、情感态度与价值观；
- 核心素养下展开 4 个维度，并继续连接 12 项课程目标；
- 语文实践下展开阅读与鉴赏、表达与交流、梳理与探究，并继续展开 15 项学生能力；
- 学习任务群下展开 18 个任务群；
- 学业质量下展开 5 个质量等级和 4 个仅作研究导航、明确标记为 `reviewed_inference` 的分析维度。

本体当前只发布 `普通高中语文课程标准（2017年版2020年修订）` 与 `盲校义务教育语文课程标准（2016年版）` 中已有官方证据锚点的结构。盲校“三维目标”不得外推为普通义务教育版本，高中任务群、核心素养和学业质量也不得倒灌到更早版次。学业质量表中的 20 项细目尚未完成逐行图像结构复原，继续 fail-closed，不以 OCR 行序猜测上下级关系。

每个 episode 另带 `visibility_facets` 与 `visibility_policy`。单学科模式只接受直接受控学科归属或经过审核的课程关系；跨学科框架保持 global-only。因此“综合康复—运动能力”“律动—艺术表现”之类词面相同但课程语境不同的观察点，不再泄漏进语文或其他单学科视图。

## 学科 taxonomy 的权威来源

1. 教育部 JY/T 0644—2022《教育基础数据》表 8 是基础教育学科名称与已核 SB code 的权威锚点：<https://www.moe.gov.cn/srcsite/A16/s3342/202302/W020230214589106063444.pdf>。本次核对文件 SHA-256 为 `fa5fcd758e434353c1d9625968f125d9d1b2a69820a0e364ee48cd4e03d95aa5`。
2. 教育部《三类特殊教育学校义务教育课程标准答问》确认特色课程标准的课程实体身份：<https://www.moe.gov.cn/jyb_xwfb/s271/201612/t20161213_291721.html>。这些项目作为 reviewed extension 保留，`official_code=null`，不得伪造 SB code。
3. 教育部发布体系把课程方案与各门学科课程标准分列；因此“课程方案”是跨学科框架，不是学科。JY/T 表 8 含 `综合实践活动=SB0801`，但本项目面向教师的筛选语义将它保留为 `curriculum_course`，不把它混入“全部学科”。JY/T 表 8 不含“课程方案、考试评价、考试大纲、综合、艺术与劳动”；来源标签 `综合` 也不得被偷换为“综合实践活动”。

权威 URL、文件散列、核对范围、决定规则和代码映射均存入 `data/concept-model-v2.json`，并复制到构建产物的 `taxonomy_provenance`/`taxonomy_decision_rules`。

## 来源标签重分类清单

### 不进入学科 facet

| 来源值 | entity_kind | 处理 |
|---|---|---|
| `课程方案` | `cross_cutting_framework` | 保留课程方案作品、版次、覆盖和 scope episode；不进入学科 facet |
| `考试大纲` | `assessment_domain` | 跨学科考试文件，不作为课程学科 |
| `考试评价` | `assessment_domain` | 评价政策/体系，不作为课程学科 |
| `艺术与劳动` | `source_collection` | 音乐·美术·劳技历史汇编卷集合，不是单一学科 |
| `综合` | 默认 `cross_cutting_framework` | 必须按文档标题 override；不允许一刀切映射为综合实践活动 |
| `定向行走`、`综合康复`、`社会适应`、`沟通与交往`、`律动`、`康复训练`、`生活适应`、`劳动技能`、`运动与保健`、`艺术休闲`、`美工`、`绘画与手工`、`唱游与律动`、`生活语文`、`生活数学` | `curriculum_course` | 保留课程实体、课程族与关联学科，但 `facet_eligible=false` |
| `技术` | `curriculum_course` | 保留历史课程名称及与通用技术、信息技术的关联，不作为当前学科 facet |
| `综合实践活动` | `curriculum_course` | taxonomy-only 课程实体；保留 `SB0801` 锚点但不进入学科 facet |

`综合` 来源值的文档级审核结果：

| 文档 ID | 重分类 |
|---|---|
| `ictr-d692b0ff2e6c` | `subject=思想品德`，修正损坏目录标签 |
| `ictr-197f8a2e1cca` | `subject=音乐`，修正损坏目录标签 |
| `policy-1950-1993-overview` | 跨学科课程沿革概述 |
| `policy-2001-reform-outline` | 跨学科课程改革纲要 |
| `policy-2003-hs-standards` | 高中课标发布通知 |
| `policy-2000-hs-syllabi` | 高中大纲修订背景 |
| `catalog-legacy-originals` | 历史原件待补目录 |
| `catalog-revision-watch` | 课标修订监测集合 |
| `ictr-cfb2a39a2016` | 聋校跨学科课程设置方案 |
| `ictr-8f02447b66ca` | 盲校跨学科课程设置方案 |
| `ictr-f74769862cc6` | 培智学校跨学科课程设置方案 |
| `ictr-f4258201b960`, `ictr-6aed243f91fa`, `ictr-07a04c6c51fd` | 普高/义教跨学科课程方案 |
| `legacy-compendium-general-primary` | 自然·社会·常识·卫生多学科汇编卷 |

### 保留来源差异的规范化

| 来源值 | 受控学科 | 保留信息 |
|---|---|---|
| `普通高级中学 体育体育与健康` | 体育与健康 | 原标签是损坏的复合来源值，保留 `source_label` |
| `初中科学` | 科学 | 学段由 curriculum line 保存为初中 |
| `文科数学`, `理科数学` | 数学 | `course_variant=humanities_track/science_track`，不重复成两个学科 |
| `生物`, `生物学` | 生物学 | 共享 `stable_subject_id=subject:biology`，保留历史 source label |
| `信息技术`, `信息科技` | 各自名称 | 共享 `lineage_family=information_technology_education`；未完成改名连续性审核前使用不同 stable ID |

精确身份、展示分面与查询资格分层处理。汉语仍以 `entity_kind=assessment_subject`、`canonical=汉语` 保留来源身份，但其 `facet=语文`，不再成为独立星图开关，也不能作为普通学科的版本比较、全文或 AI 筛选值；它仍可通过篇名、文档 ID、无学科限制的资料库与语文展示分面发现。英语、日语、俄语、德语、法语、西班牙语统一显示为“外语”；思想品德、思想政治、道德与法治、品德与生活、品德与社会统一显示为“思想政治与道德法治”；科学、物理、化学、生物/生物学统一显示为“科学类”；信息技术、信息科技、通用技术统一显示为“技术”。这些 `facet` 只控制配色、显隐与元数据浏览；普通学科的 canonical、stable ID、官方代码、curriculum line、版本比较和引文筛选仍保持精确，不把展示归并解释为历史改名、制度合并或学科等同。

特色课程全部使用 `entity_kind=curriculum_course`，通过 `course_families` 归入语言与沟通、数量与生活、艺术与律动、康复与适应、劳动技能等课程族；`course_to_subject_links` 只表达可审核的关联入口，不把课程等同或并入关联学科。episode 同时保留兼容字段 `scope_entity` 与显式 `course_entity`，因此课程不会冒充 scope 或 subject。学校类型/子类另存在 curriculum line，不拿课程名称替代学校类型。

## 频率、文本复用与覆盖度

完全相同的段落若出现在达到阈值的多份文档中，进入 `text_reuse_cluster`。命中不会被删除：

- `mention_count` 保存全部精确命中；
- `local_unique_mention_count` 排除共享文本候选；
- 频率分子是后者，分母是排除共享段落后的 `eligible_meaningful_characters`；
- `comparability=within_edition_descriptive_only`，`interpretation=null`。

每个 edition/page fragment 都有 coverage cell。当前所有 cell 固定 `negative_claim_eligible=false`、`alias_search_complete=false`；OCR 页片段固定 `complete=false`。所以语料未命中不能被转述为概念尚未出现、已经消失或被取代。

## 校验

```bash
node scripts/build-concept-evolution.mjs
node scripts/validate-concept-evolution.mjs
node --test tests/concept-evolution-academic-schema.test.mjs
```

校验器检查实体 ID/FK、12 个展示 facet 与全部精确学科身份的唯一映射、目录分类精确计数、课程族/关联学科、显式 `course_entity`、盲校与聋校课程线隔离、2017/2020 版次修订、逐次词面偏移、未知字段不推断、关系双端证据、非语义关系禁止影响主张、OCR 禁止引文、coverage 负面结论关闭，以及非学科来源值不得进入 subject facet。它还逐一验证 76 个本体节点的 scope、父节点、证据锚点和关系端点，固定检查 12 项课程目标、15 项学生能力、18 个任务群、5 个质量等级，并对全部 12 个学科执行隔离回归。
