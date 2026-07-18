# 历史汇编篇目边界与发布门

## 目标

`data/compendium-item-boundaries.json` 保存扫描汇编内“篇目”的候选边界与证据状态。它解决的是一卷 PDF 内含多份历代文件时的身份切分，不把目录行、单页标题或 OCR 猜测当成完整作品。

目录候选默认全部 `display_allowed=false`、`citation_allowed=false`、`semantic_claim_allowed=false`。目录标题、年份和印刷页码即使已由人工对照扫描图，也只可导航。

## 三层放行

1. **显示**：当前篇正文标题已由扫描图、主 OCR、独立 Vision witness 三方核对；下一篇正文标题也已核对（末篇使用 catalog/queue 共同绑定的源文件精确页数）；候选范围内每一页都在页级发布清单中 `display_allowed=true`；页集合 SHA-256 与当前 `corpus-…` release 完全一致。
2. **引文**：在显示条件之上，范围内每页均允许引文，并有官方或学术来源的同篇同版完整文本核对。核对记录必须绑定当前完整主文本 SHA-256，异版文本不得提升引文门。
3. **语义**：在引文条件之上，编辑明确审核概念词形的语义范围。即使篇目通过语义层，自动词面命中仍只证明出现位置，不自动生成改名、取代、影响或因果关系。

显示层的完整性是“所有物理页均有证据”，不是“概念搜索无遗漏”。所有 coverage cell 继续保持 `alias_search_complete=false` 与 `negative_claim_eligible=false`。

## 边界证据

- `toc_evidence`：目录页主 OCR 与扫描图 SHA-256、人工核对者和时间；仅导航。
- `body_heading`：正文首标题原文、标题 SHA-256、整页主 OCR SHA-256、扫描图 SHA-256、Vision JSON SHA-256、核对者和时间。
- `page_evidence`：当前 corpus release、首末物理页、页数及按顺序投影的页集合 SHA-256。
- `online_verification`：版次关系、比较范围、主文本与在线文本 SHA-256、受控来源 ID、核对者、时间和说明。
- `semantic_review`：只在引文门已开后记录编辑语义审核。

正文标题必须与目录标题经 NFKC 和受控空白规范化后相同。当前篇的末页只能是下一篇已核正文标题之前一页；末篇只能结束于 catalog 与 OCR queue 同时确认的源文件末页。附件有独立 item ID，并显式链接相邻同年父篇目。

## 运行顺序

```bash
npm run corpus:build
npm run compendium:boundaries:validate
npm run concepts:build
npm run concepts:validate
node --test tests/compendium-item-boundaries.test.mjs tests/concept-evolution-academic-schema.test.mjs
```

先构建 corpus 是硬约束：篇目页集合包含当前 corpus release ID，旧 release 的人工记录不能继承到新正文。完整验证还会重新读取主 OCR、Vision witness 和页级发布门；校验后文件被替换、缺页、顺序变化、在线记录未解析或同版关系不成立时，构建直接失败。

重新生成目录候选时必须显式提供源 SHA-256、总页数、印刷页到物理页偏移、目录页、OCR/witness 根目录、核对者与 UTC 时间，并把 `--output` 指向一个全新的审查路径。生成器使用排他创建，拒绝覆盖任何现有文件；候选输出会关闭所有正文、在线、引文和语义门，只能在逐项证据 diff 后受控合并，不能覆盖已审核记录。
