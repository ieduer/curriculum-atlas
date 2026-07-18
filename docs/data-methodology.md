# 数据与证据方法

## 来源分层

1. 教育部、课程教材研究所、教育考试机构的原始发布页与原始文件。
2. 课程教材研究所编纂的历史汇编扫描件；扫描图像是历史措辞的第一记录。
3. 官方或学术机构保存的同一文件、同一篇目或稳定事实在线文本。
4. 二手新闻、搜索摘要和模型输出只能定位线索，不能作为最终原文证据。

每个来源保存稳定文档编号、来源页、文件 URL、获取状态、SHA-256、重分发边界和文本质量状态。无法取得的原件保留元数据记录，不用近似文本填补。

## OCR 与在线核对

扫描件按页处理。主识别为 PaddleOCR-VL 1.6 完整版面管线，Apple Vision 是独立快速复核，PP-StructureV3/PP-OCRv5 用于冲突裁决。目录只能生成导航候选，不能直接生成星点：每篇必须再绑定正文首标题、下一篇正文首标题（末篇绑定源文件精确卷末）、范围内全部页的图像/主 OCR/独立 witness 与当前 corpus release。任何缺页或哈希漂移都会关闭整篇显示，不再用单页片段替代完整篇目。

在线来源必须记录以下版次关系之一：

- `exact_document_exact_edition`：同一文件同一版，可核对措辞。
- `exact_document_revision_uncertain`：文件相近但修订状态不明，只能提示冲突。
- `same_work_different_edition`：同篇异版，只核稳定事实，不替换历史措辞。
- `stable_fact_only`：作者、篇名等跨版本稳定事实。
- `not_matched`：不能作为该项证据。

放行精确引文必须同时具备扫描页与哈希、主 OCR、至少一个独立 OCR、明确文件身份、官方或学术在线证据以及人工复核。汇编篇目的在线记录还必须保存同篇同版关系、完整主文本 SHA-256、在线文本 SHA-256、来源记录、核对者、时间与范围；异版材料只能核对稳定事实。不能确认时可由编辑作带疑点的非精确结论，但必须 `citation_allowed=0`。

## AI 证据边界

全文检索和 AI 检索同时要求 `documents.citation_allowed=1` 与 `paragraphs.citation_allowed=1`。模型只获得本轮检索段落和 `[P:id]` 编号；输出若没有引文或引用越界，整条回答拒绝。只存问题哈希、检索段落编号、引用编号、模型标签与状态，不存原始教师问题。

## 讨论与隐私

已登录教师讨论直接公开；匿名讨论经 Turnstile 后进入审核。数据库不保存原始 IP，限流使用 HMAC 后的不可逆标识。讨论不得写入学生个人信息。管理员操作写入内容审计表。

## 已知边界

- OCR 通过抽样不等于整份文档通过；必须逐页放行。
- 在线文本可能来自后续修订版，必须显式标注版次关系。
- 当前历史扫描正文未批量开放；已核验的单项事实可独立展示证据链。
- 教育部修订动态不等于新标准已经发布。

## 概念演进分析边界

星点表示“一个受控概念词形在一个明确课程线和版次中的观察”，不表示课标文件本身。构建顺序是 `surface_form → occurrence → evidence → episode`；在取得定义证据或人工分义前，每个 concept 只有一个 `undifferentiated_unresolved` sense，学科/版本语境只存在 occurrence/episode 中，因此不会把空白学科占位伪装成语义义项。

精确重复段落不再被删除。跨达到阈值的多份文档出现的完全相同段落进入 `text_reuse_cluster`，命中仍保留在总次数和证据中，但从 `local_unique_mention_count` 与频率分子、分母中单独排除。`normalized_per_10k` 仅供同一概念的界面尺度展示；频率对象固定声明 `within_edition_descriptive_only`，不得据此生成跨版本“增强/减弱”结论。

自动关系只表示当前语料中的下一次词面观察或同年跨学科共现。关系必须保存 source/target 两端独立证据；共现是对称关系，显示链不是传播方向。改名、拆分、合并、取代、影响和因果关系必须由编辑以双端版本证据另行审核。

“未命中”不能证明概念尚未出现或已经消失。所有 coverage cell、episode 和总图均关闭首次出现、消失、历史最高/最低和负面历史主张。

## 学科 facet

目录的原始 `subject` 是来源标签，不是受控筛选值。构建器先应用 `data/concept-model-v2.json` 的来源标签映射与文档级 override，再把普通学科和考试评价身份写成精确 `canonical`。D1 v2 以 `taxonomy_entity_kind` 保存七类精细身份，并以 `display_facet` 保存 12 个展示分面；legacy `entity_kind/scope_kind` 仅供兼容旧客户端。`汉语→语文`、各外语语种→外语、历代思想政治/道德法治名称→思想政治与道德法治、科学分科→科学类、信息/通用技术→技术只影响星图和资料库展示，不改变 canonical、stable ID 或官方代码。普通学科才可进入精确学科查询、版本比较与 AI 学科筛选；`assessment_subject` 可在关联展示分面和元数据检索中发现，但不能伪装成普通学科筛选值。特色课程、历史“技术”课程与综合实践活动采用 `taxonomy_entity_kind=curriculum_course`、`facet_eligible=false`，由 `course_families` 和 `course_to_subject_links` 保存课程族及关联学科，并在 episode 中显式写入 `course_entity`。课程方案、考试评价、考试大纲、跨学科政策、汇编卷和来源目录分别保存为评价领域、跨学科框架或资料汇编；都不会污染普通学科查询。

一般学科命名和已核代码以教育部行业标准 JY/T 0644—2022《教育基础数据》表 8 为锚点；特殊教育特色课程以教育部 2016 年三类特殊教育学校课程标准答问作为受控扩展，保留课程实体身份但不伪造 SB code。D1 v2 仍把 `curriculum_course` 的 legacy 兼容列保存为 `entity_kind=scope, scope_kind=curriculum_course`，但权威语义来自 `taxonomy_entity_kind=curriculum_course`；这是兼容映射，不改变学术模型中的三层语义。详细映射、版本散列与决定依据见 `docs/concept-evolution-academic-model.md`。
