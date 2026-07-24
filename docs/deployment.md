# 部署、验证与回滚

## 当前线上锚点

| 环境 | Worker version / deployment | Assets Git | Corpus | R2 current |
|---|---|---|---|---|
| preview | `037df3d0-e192-4045-ad15-b7449dba2a28` / `2c379122-0e8a-40a6-b7cb-01bfcbcf725e` | `efafbc1de81ebbd8445beb415f3e2002fa395831` | `corpus-1c4f6b41737380f3e71246dd` ready | `release-cd9ec4a050cbabbede744192398ebfa7` |
| production | `55653436-b55a-4aef-986d-b11dbd84b36e` / `eb93d28c-aa96-48ac-80e1-0a4af031c75e` | `6eea3a540c05b7d9ab6ef0807de59b163535288a` | `corpus-1c4f6b41737380f3e71246dd` ready | `release-cd9ec4a050cbabbede744192398ebfa7` |

两端 health 均为 `2026.07.24-v19`、schema 3 / taxonomy 2 / page-publication 1，migration `0001`–`0007`，D1/R2/APIS/User Center/Assets 五项 binding 全真。Corpus 精确为 196 / 16,500 / 16,500 / 8,808 / 16,500 / 26 / 103（documents / paragraphs / FTS / page gates / displayed / accepted OCR documents / chunks）。

## 目标资源

| 环境 | Worker | D1 | R2 | 域名 |
|---|---|---|---|---|
| preview | `bdfz-curriculum-atlas-preview` | `bdfz-curriculum-atlas-preview` | `bdfz-curriculum-atlas-sources-preview` | `https://bdfz-curriculum-atlas-preview.bdfz.workers.dev` |
| production | `bdfz-curriculum-atlas` | `bdfz-curriculum-atlas` | `bdfz-curriculum-atlas-sources` | `https://curriculum.bdfz.net` |

## 发布合同

一次 release 必须同时绑定：

- clean、已推送的 exact Git commit；
- OCR 机器裁决、页级发布、候选观察、2001 年前 identity、百年模型与学科分合收据；
- 39/39 数据质量、24/24 百年模型、11/11 深层模型、11/11 静态性能、16/16 preview runtime；
- 103 个 corpus SQL chunk 的 name/hash/bytes 和远端 receipt；
- core graph 与 64 个 academic shards 的 build revision/hash/bytes parity；
- D1 migration、唯一 100% Worker version、五项 live asset byte parity 与 health provenance；
- 17 个 R2 immutable objects、manifest、current pointer 的完整 readback；
- 若 historical reader 有变更：461 个私有 item objects、manifest 与 `historical-reader/current.json` 的逐对象 hash/bytes readback；
- desktop/mobile 单一 Canvas、亮/暗主题、多年份比较、inspector safe viewport、零横向溢出与 console 检查。

任一失败在远端 mutation 或 pointer 切换前 fail closed；`manual_override_allowed=false`。

## 标准发布流程

### 1. 所有权、冻结和本地门

```bash
cd /Users/ylsuen/CF/curriculum-atlas
git status --short
npm ci
npm run verify
npx wrangler whoami
```

核对 action log 没有重叠 owner；记录 `start`。源码或生成资产 dirty 时禁止部署。

### 2. 回滚锚点

```bash
npx wrangler deployments status --name <WORKER> --json
npx wrangler d1 migrations list <DATABASE> --remote
npx wrangler d1 time-travel info <DATABASE> --timestamp <RFC3339_NOW> --json
npx wrangler r2 object get <BUCKET>/release/current.json --pipe --remote
```

保存 Worker predecessor、D1 Time Travel bookmark、R2 predecessor pointer 和用户/运维表基线。FTS5 virtual table 可能阻止整库 SQL export；此时 Time Travel 是主回滚，非 FTS 业务表 export 是第二证据，不能伪装成全库备份。

### 3. Corpus import

```bash
npm run corpus:build
npm run corpus:import:preview
```

Importer 逐块写 receipt，只在全部计数精确一致后 finalize `ready`。中断时查询已提交 receipts，从第一个未提交编号恢复：

```bash
npm run corpus:import:preview -- --from <NNN>
```

不要盲目重放已提交块。Preview 全部通过后 production 执行 `npm run corpus:import:production`。

### 4. Worker deploy 与 evidence

```bash
npm run deploy:preview
npm run release:evidence:preview
git add data/release-environment-evidence.json
git commit -m "chore: bind preview release evidence"
git push
```

Production 只有在 preview runtime/browser 门通过后执行：

```bash
npm run deploy:production
npm run release:evidence:production
git add data/release-environment-evidence.json
git commit -m "chore: bind production release evidence"
git push
```

Evidence 必须来自命令回执和 live byte parity，禁止手改。

### 5. R2 原子发布

```bash
npm run metadata:publish:preview
npm run metadata:publish:production
```

发布器顺序固定：immutable objects → 每对象 readback → manifest/readback → current pointer → pointer readback。中断时先读当前 pointer 和目标对象；pointer 未切换则旧版仍在线，已上传的未引用 immutable objects 可保留；pointer 已切换则先完成 readback。不得覆盖 immutable key 或盲目重跑。

历史原页阅读包独立于公开 metadata pointer，固定先 preview、后 production：

```bash
npm run historical:reader:build
npm run historical:reader:check
npm run historical:reader:publish:preview
npm run historical:reader:publish:preview -- --apply
npm run historical:reader:publish:production
npm run historical:reader:publish:production -- --apply
```

发布命令不带 `--apply` 时只读取远端 pointer 并输出 dry-run。`--apply` 顺序为 461 个 item objects 与 manifest 上传 → 462/462 全量 readback → 最后写入 `historical-reader/current.json` → pointer readback。中断且 pointer 未切换时，旧版不受影响；pointer 已切换时必须完成 readback。回滚只恢复 predecessor pointer 原始 bytes，immutable objects 保留供审计；若 predecessor 为 `null`，移除 current pointer 即关闭入口，不能删除整桶。

### 6. API、浏览器与依赖验收

```bash
curl -fsS https://curriculum.bdfz.net/api/health
curl -fsS https://curriculum.bdfz.net/api/meta
curl -fsS 'https://curriculum.bdfz.net/api/search?q=核心素养'
curl -fsS https://curriculum.bdfz.net/api/source-manifest
```

浏览器必须验证：

- 只有一个 Canvas，没有第二 timeline；
- 暗色、亮色文字与四类实线可读；
- 任意多个年份可同时选择，年代阶段和年份比较互不干扰；
- 实际点击星点会高亮同层概念族并适配镜头；
- inspector 在桌面选择星群对侧，在手机位于底部安全视窗外；
- 1440×1000 与 390×844 无横向溢出，console errors/warnings 为 0；
- `/compare` 与 `/sources` 均无 `page_count` 例外；`/archive` 条目可进入 `/historical/<id>`；
- 匿名调用 `/api/historical/<id>` 返回 401 且不读 R2；登录后可加载单条 PDF 原页与逐页 OCR 候选，响应不可缓存且不提供整卷；
- 关闭命名会话，执行 orphan dry-run。

共享 hub 仅做只读依赖 smoke，不修改合同。

## v19 学科百年链回滚

- 最终 v46 Production predecessor：`c876f21f-2a86-4a5a-b847-a549541b9afb`（v19/v45）。
- 完整回到 v18 Production：`10c8d648-26d7-4e26-bd99-61b80dd9e0cc`。
- 源码 tag：`curriculum-baseline-20260724-v18-10c8d648`；backup branch：`backup/curriculum-v19-discipline-lineage-toggle-20260724`。
- v19 只改 Worker/Assets 和可重算资料资产，未写 D1、R2、OCR 远端输出或共享 hub；回退 Worker 后核对 health、`app.js?v=`、11 学科按钮与既有 corpus ready 即可，不执行 D1 Time Travel 或 R2 pointer 回切。

## v19 正式验收记录

- Production health 200、`cache-control: no-store`，Worker `55653436…`、release Git `6eea3a5…`，corpus expected/actual/live 精确相等。
- `discipline-lifecycle.json` schema 2：11 条学科百年链、9 个来源明示事件；1923「社会科合科编组」公开分面精确为思政／历史／地理。
- 在入场动画只载入至 1991 年时立即点击，立即及 3.8 秒后都保持「全部 58 个有资料年份」，没有回锁 1902 或 1923；第二次事件点击退回历史链，第二次历史链点击恢复 11 学科。
- Preview v46 实测：桌面 ready 853.2 ms / draw p95 4 ms；手机 ready 1437.2 ms / draw p95 2.5 ms；两端横向溢出 0。

## v18 回滚

### Worker + D1

- Production predecessor Worker：`3f8951d8-28ce-4b53-b936-5411b4d23b73`
- Preview predecessor Worker：`faa7a9bf-e010-42d7-b635-332486f4b0fc`
- Production D1 bookmark：`000000d6-00000000-000050b2-6e1bdf145e5aea4b984d2581ca5724f9`
- Preview D1 bookmark：`00000071-00000000-000050b2-0b529d53eb22aae53e6dc536a85995cc`

回到 v17 必须评估并耦合恢复 D1，因为 v17 内嵌的是旧 corpus fingerprint/counts；只回 Worker 会 fail closed。Time Travel 前先确认 bookmark 后是否有合法评论、举报、限流或 AI 审计写入。

### R2-only

- Production predecessor：`release-9cb02f77c06ee0535e7981a22b312373`
- Preview predecessor：`release-841a528f0086ce69f2f7a6f2d07c0999`

恢复 predecessor `release/current.json` 原始 bytes；不删除 v18 immutable objects。恢复后重新 GET pointer、manifest 和 17 个对象核对 hash/bytes。

### 源码

- tag：`curriculum-baseline-20260724-v17-3f8951d8`
- backup branch：`backup/curriculum-v18-machine-publication-light-lines-20260724`

## v18 正式验收记录

- Production health 200，Worker `10c8d648…`，corpus expected/actual/live 精确相等。
- 1902 + 2022 对比显示 223 个可见星点；总图 2,415 episodes、3,144 edges、5,304 evidence。
- 实际 Canvas 点击打开 `whole-book-reading` deep link；“阅读与鉴赏”深链同时照亮 4 个同层概念、58 个观察点。
- 亮色选中演进线为清晰深蓝实线；桌面 inspector 370 px 并移至星群对侧，手机 safe viewport 在 bottom inspector 之前结束。
- 1440×1000 与 390×844 均 `scrollWidth=innerWidth`，console error/warning 0，命名浏览器已关闭。

## 禁止事项

- 不从 dirty tree、stale evidence、未 ready corpus 或失败质量门部署；
- 不把 OCR complete、候选 observation 或远端 staging 写成正式引文；
- 不把冲突页交给模型生成第三份猜测文本；
- 不跳过 corpus receipt、R2 immutable readback 或 pointer readback；
- 不把原 PDF、完整受版权约束 OCR、secret、cookie、session 或用户内容放入公开 R2、Git 或报告；
- 不修改共享 hub、旧 OCR receiver/monitor、远端 OCR unit 或旧 output tree。
