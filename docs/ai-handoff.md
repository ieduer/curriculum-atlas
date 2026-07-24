# AI / 开发者接手说明

## 必读顺序

1. `README.md`
2. `docs/PROJECT_MANUAL.md`
3. `docs/PROJECT_AUDIT_2026-07-23.md`
4. `docs/data-methodology.md`
5. `docs/ocr-quality.md`
6. `docs/data-model.md`
7. `docs/deployment.md`
8. `docs/operations.md`
9. `docs/project-operations-ledger.md`
10. `/Users/ylsuen/CF/runbooks/bdfz_project_matrix_and_interdependencies.md`（仅 BDFZ 内部运维环境）

## 不可突破的边界

- 产品只有一张 Canvas 星图。年代、学科、概念关系和概念深挖都是同一星图的显隐、选中与镜头状态；不得增加第二时间轴或第二星图。
- 所有关系线都是实线。虚线、`setLineDash`、暗示语义不确定性的线型均禁止进入源代码或生成资产。
- OCR 完成、候选观察、正式引文和语义关系是四种不同状态。候选观察不得冒充引文；概念族不得冒充语义等同、替代、影响或因果。
- OCR 双见证页使用确定性机器终局：逐字完全一致且来源/页图/文本哈希全部通过者才可发布；任何文字或表格冲突都终局 `fail_closed_omission`，不进入人工待审队列，也不生成第三份猜测正文。
- 原 PDF、整本受版权约束转录、用户数据和秘密不进入 GitHub 或公开 R2。
- 叶项目不创建 Gemini key，只使用 `APIS` binding；不绕过 User Center 自建账户系统；不修改共享 hub 合同。
- 先 preview、后 production；D1、Worker Assets、environment evidence、R2 pointer 和浏览器证明必须属于同一发布链。
- 不修改被冻结的旧 OCR receiver/monitor、远端 OCR unit 或旧 output tree。新数据只由可重放 builder 读取既有证据并生成。

## v18 正式基线

- 正式站：`https://curriculum.bdfz.net`；Worker `2026.07.24-v18`，version `10c8d648-26d7-4e26-bd99-61b80dd9e0cc`，deployment `38cb4825-ff25-498b-9fbb-c9fb4c9d394a`，Assets Git `e34e5af224f3c431618d11bcf7f6866f7636b69f`。
- Preview：version `f90b350a-6880-43f3-a6ec-c93a602829e3`，deployment `e166e393-68d6-4f57-9469-46a4bde7bd21`，Assets Git `67733f9c2203dd8b41612847037b90cfd0cba226`。
- 两端 migration `0001`–`0007`，health schema 3 / taxonomy 2 / page-publication 1，D1/R2/APIS/User Center/Assets 五项 binding 全真。
- Corpus `corpus-1c4f6b41737380f3e71246dd` 两端 `ready`：196 documents、16,500 paragraphs、16,500 FTS、8,808 page gates、16,500 displayed、26 accepted OCR documents、103 chunks。
- R2 两端 current 均为 `release-cd9ec4a050cbabbede744192398ebfa7`；各自完成 17/17 immutable objects 与 manifest readback 后才切换 pointer。production manifest SHA-256 为 `7b2b836ae29c98743b3a3248eac8e013a4b6c048ac473b0c95685804fb365018`，preview 为 `9e964d6c8e3898dcb8078e4f0b5b8780cd3379e566abff8c12efc5b84ee63bc1`，均为 188,566 bytes。
- 合并后的单一星图为 2,415 episodes、3,144 edges、5,304 evidence、12 个存储身份／11 个公开学科分面；55 个同层概念族含 1,648 memberships 和 1,348 条候选关系边。
- 学术图保持完整语义模型，但以 30,220-byte 索引和 64 个内容寻址分片传输；最大分片 524,250 bytes。materializer 必须复核 SHA-256、bytes、build revision、collection、chunk 与计数。

## 三个数据工作包的终态

1. **机器裁决与正式发布**：6,947/6,947 双见证页已终局机器裁决；31 exact、73 blank、5,063 文字冲突关闭、1,780 表格冲突关闭、pending 0、human-required 0。31 exact receipts 去重为 26 份文件的 30 个唯一可引页和 44 个段落候选。
2. **完整 OCR 观察层**：83 份完整文件／10,210 页／8,346,639 字符，70 份可投影文件生成 308 episodes、308 evidence、154 lineage 和 60 co-occurrence edges；全部是 nonsemantic、noncitable 候选。
3. **2001 年前专科汇编身份**：462/462 bounded items 取得唯一 identity receipt；461 个物理页段、1 个有意共享页段、134 个来源篇目解析为 135 条 source links，失败 0。

## 核查标准

`data/data-quality-standard.json` 是发布阻断标准，`manual_override_allowed=false`。当前固定执行：

- 34/34 数据细度与准确度检查；
- 20/20 百年模型检查及 11/11 深层模型检查；
- 候选 JSON Schema、episode stable-ID diff、关系端点与证据闭包；
- 11/11 静态性能预算和 16/16 preview 运行时预算；
- 亮色四类选中实线相对 `#edf1ee` 均须达到 4.5:1；
- 单一 Canvas、无虚线、多年份可任意组合、inspector safe viewport、desktop/mobile 无横向溢出；
- 任一失败阻断 preview 和 production，不能人工覆盖。

机器验证收据中的 `production_citation_ready_pages=0` 表示“机器裁决阶段尚未写 manifest”；正式发布状态以其下游、哈希绑定的 `data/ocr-publication-receipt.json` 和 `data/page-publication-manifest.json` 为准，当前唯一可引页为 30。不要把两个阶段字段相加或互相覆盖。

## 修改闭环

1. 确认来源、所有权与真实运行路径，记录 action-log `start`。
2. 生产数据变更前保存 Worker predecessor、D1 Time Travel bookmark 与必要的非 FTS 业务表 SQL。
3. 运行确定性 builder 和 `npm run verify`；生成文件必须与重算结果逐字节一致。
4. Preview 导入、部署、environment evidence、runtime/browser QA 全部通过后才提升 production。
5. Production 重复 exact corpus import、gated Worker deploy、R2 immutable readback、API 和 desktop/mobile 浏览器 QA。
6. 更新项目手册、operations ledger、canonical report 与 action log；关闭命名浏览器并运行 Playwright orphan dry-run。

## 当前未决边界

- 没有 v18 发布 blocker。未通过逐字 exact gate 的 6,843 个非空冲突页和 73 个双空白页已取得终局机器关闭，不是“等待人工”的 backlog。
- 候选观察只证明“在受控来源页看到这个词面”，不证明首次出现、消失、制度替代、语义等同、影响或因果。更深语义只能由独立、可引用证据另行发布。
- 86 份／11,847 页是目录身份分母，85 份／11,779 页是物理去重分母；两者都必须保留。原 1,077 页 Apple Vision 单见证已进入候选覆盖，但不能单独满足正式引文门。
- DMITPro2 B-r1 的历史冻结状态保留为审计证据，不再阻断 v18；本轮没有改动远端 OCR service、旧 receiver/monitor 或旧 output。

## 回滚

- 源码基线：tag `curriculum-baseline-20260724-v17-3f8951d8`，backup branch `backup/curriculum-v18-machine-publication-light-lines-20260724`。
- Production Worker predecessor：`3f8951d8-28ce-4b53-b936-5411b4d23b73`；preview predecessor：`faa7a9bf-e010-42d7-b635-332486f4b0fc`。
- Production D1 pre-import bookmark：`000000d6-00000000-000050b2-6e1bdf145e5aea4b984d2581ca5724f9`；preview 为 `00000071-00000000-000050b2-0b529d53eb22aae53e6dc536a85995cc`。恢复前必须检查 bookmark 后的合法用户写入。
- R2-only 回滚恢复 predecessor pointer：production `release-9cb02f77c06ee0535e7981a22b312373`，preview `release-841a528f0086ce69f2f7a6f2d07c0999`；保留所有 immutable v18 objects。
- v17 Worker 与 v18 corpus 不是可长期混用的组合；需要回到 v17 时必须按运维手册评估并耦合恢复 D1。
