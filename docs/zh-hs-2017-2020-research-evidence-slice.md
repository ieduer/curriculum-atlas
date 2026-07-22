# 普通高中语文 2017→2020 研究证据纵切片

## 目的与边界

`data/research-evidence/zh-hs-2017-2020.json` 是第一个把同一组 `assertion_id` / `evidence_id` 贯穿 compare、reader/search、星图、AI 和讨论目标的真实证据纵切片。它不是公开版本差异数据，也不修改 D1、公开星图、本体或发布指针。

每条 evidence 都必须同时解析：私有 corpus release、文档身份、段落 ID/ordinal、物理 PDF 页、段落正文 SHA-256、UTF-16 起止位置、精确短引文、页级 publication gate、240 DPI 页图、在线 HTML 快照正文和在线 UTF-16 span。PDF 镜像若 SHA-256 与主制品相同，只能标为 `integrity_only_same_artifact`，不能满足独立在线文本条件。

本 successor 从 `ba9fa6a` 候选的 91 个逐项验签 SQL 分片重新物化 195-document SQLite，并把六个 span 重新绑定到 `corpus-4fe2f31344f52706de761788`。两份 PDF 的六个目标页又用 Poppler `pdftoppm 26.07.0` 以 240 DPI 独立重渲染；六张 PNG 均与已固定页图逐字节相同。这证明当前 corpus/page 定位未随去重漂移，但仍不是签名编辑复核。

## 当前结论

本切片包含三条研究观察、六个精确段落 span：

1. 课程性质段落的两版育人目标文字并列观察；证据解析完整，仍待签名编辑确认比较边界。
2. 基本理念对应语句从“促进人的全面发展”到“促进学生全面而有个性的发展”的精确文字观察；PDF、corpus、页图和同版在线转录一致，仍待签名编辑裁决。
3. 核心素养定义中“正确价值观念”与“正确价值观”的候选版本差异；2017 PDF 和教育部发布页支持“价值观念”，但维基文库同版核心素养段落转录为“价值观”。该冲突被显式保存，且缺少段落位置一致的独立全文见证，所以该 assertion 的 `research_evidence_ready=false`。

三条 assertion 均为 `publication_eligible=false`。仓库中的 reviewer authority 仍为空，不能把本次机器辅助页图核对伪装成签名编辑复核。

每条语义声明同时保留可并存的状态标签，避免把“原文已精确定位”误写成“内容已获准发布”：

| assertion | 证据状态 | 公开图谱 | 比较 API | AI 引用 |
|---|---|---:|---:|---:|
| 课程性质与育人目标表述 | `exact-source-supported`、`editor-review-pending` | 关闭 | 关闭 | 关闭 |
| 基本理念中的全面发展表述 | `exact-source-supported`、`editor-review-pending` | 关闭 | 关闭 | 关闭 |
| 学科核心素养定义用词 | `exact-source-supported`、`online-version-conflict`、`editor-review-pending` | 关闭 | 关闭 | 关闭 |

`exact-source-supported` 只表示 PDF、corpus、页图和精确 span 可解析；`online-version-conflict` 表示同版在线转录存在尚未裁决的版本敏感冲突；`editor-review-pending` 表示还没有签名编辑决定。每条 assertion 只有一个 `release_gate`；compare、reader/search、星图、AI 和 discussion 五个消费者均原样携带它，不得各自重算或省略。实现和校验代码完成不等于内容发布。

## 本地资源映射

公开仓库不保存原 PDF、整页 PNG、在线网页快照、私有 corpus SQL 或 SQLite。验证时必须提供一个不提交的 owner-only resource map：

```json
{
  "schema_version": 1,
  "policy": "local_read_only_research_evidence_resources_v1",
  "resources": {
    "corpus:zh-canary-sqlite": "<ABSOLUTE_READ_ONLY_SQLITE_PATH>",
    "corpus:private-release-manifest": "<ABSOLUTE_CORPUS_MANIFEST_PATH>",
    "artifact:zh-hs-2017-pdf": "<ABSOLUTE_2017_PDF_PATH>",
    "artifact:zh-hs-2020-pdf": "<ABSOLUTE_2020_PDF_PATH>",
    "snapshot:wikisource-2017-html": "<ABSOLUTE_2017_HTML_SNAPSHOT_PATH>",
    "snapshot:nsfz-2020-html": "<ABSOLUTE_2020_HTML_SNAPSHOT_PATH>"
  }
}
```

实际映射还必须覆盖 manifest 中列出的官方身份页、同制品镜像和六张页图资源。缺一项、文件是 symlink、任一原始/规范正文/span 哈希不符、page gate 关闭或 corpus release 不符，验证即失败且不生成 projection。

## 验证与发布闸门

验证研究证据完整性：

```bash
npm run research:evidence:validate -- --resource-map <OWNER_ONLY_RESOURCE_MAP_JSON>
```

构建或发布流程必须再加严格参数：

```bash
npm run research:evidence:validate -- \
  --resource-map <OWNER_ONLY_RESOURCE_MAP_JSON> \
  --require-publication-eligible
```

当前严格命令按设计返回退出码 `3`，因为没有签名编辑裁决，且第三条仍有在线转录冲突。退出码 `2` 表示证据或输入完整性失败；退出码 `0` 只允许在所有 assertion 真正具备 publication eligibility 后出现。

## 五个消费者的同一身份

验证通过后产生的 fail-closed projection 使用同一 `assertion_id`、同一 evidence ID 集合和同一 `evidence_bundle_sha256`：

| 消费者 | 当前投影 | 后续接入要求 |
|---|---|---|
| compare | `public_display_allowed=false` + 统一 `release_gate` | 版本比较只能读取已签名放行 assertion |
| reader/search | document→paragraph→UTF-16 span + 统一 `release_gate` | 读者高亮和搜索命中必须复核 body/span hash |
| 星图 | `candidate_research_observation` + 统一 `release_gate` | 星边不得从词共现自动升级为版本变化 |
| AI | `retrieval_allowed=false`、`citation_allowed=false` + 统一 `release_gate` | 回答句必须引用 assertion 与两端 evidence，而非仅 `[P:id]` |
| discussion | 稳定 `research_assertion` target + 统一 `release_gate` | 可讨论候选身份，但不得把未放行 claim 显示为已核结论 |

签名编辑复核、D1 schema/import、Worker API、公开前端和部署属于后续集成层。本切片先固定可复用证据 primitive，避免不同功能各自复制文本、漂移 ID 或绕过冲突。
