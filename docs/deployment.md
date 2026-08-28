# 部署、验证与回滚

## 当前线上锚点

| 环境 | Worker version / deployment | Assets Git | Corpus | R2 current | Private historical reader |
|---|---|---|---|---|---|
| preview | `3c6f19e3-51b6-456f-9258-b09671d4d2cf` / `fc259ebe-2ba0-40b9-8e5e-493d4c270eb4` | `d1568222d6998d36644d56be0c70fe7a02aed489` | `corpus-1c4f6b41737380f3e71246dd` ready | `release-cd9ec4a050cbabbede744192398ebfa7` | `release-88cd0a6b349a0eda911080a28a842506` · 461 ready |
| production | `104ccefa-baf0-4c96-ae4b-8c1c4e25dc38` / `5b5ed424-b184-4b5e-95ea-b978207b21a9` | `d1568222d6998d36644d56be0c70fe7a02aed489` | `corpus-1c4f6b41737380f3e71246dd` ready | `release-cd9ec4a050cbabbede744192398ebfa7` | `release-88cd0a6b349a0eda911080a28a842506` · 461 ready |

两端 health 均为 `2026.07.24-v20`、schema 3 / taxonomy 2 / page-publication 1，migration `0001`–`0007`，D1/R2/APIS/User Center/Assets 五项 binding 全真。Corpus 精确为 196 / 16,500 / 16,500 / 8,808 / 16,500 / 26 / 103（documents / paragraphs / FTS / page gates / displayed / accepted OCR documents / chunks）。私有 historical reader 两端各完成 462/462 bytes/SHA-256 readback 后才切换相同 pointer，pointer SHA-256 为 `91b9686e601a78cd46546eec28589aac37d557724b88225c33e5222dcc32b621`。

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

若日志已经证明 immutable 上传阶段完整结束、但全量 readback 因 Cloudflare API 的
429/5xx 瞬时错误中断，可用同一命令追加 `--resume-readback`，只重做 462/462
全量 hash readback，再切 pointer；发布器只对 429/5xx 做最多五次的有界退避，
其他错误仍立即 fail-closed。不得在上传阶段未完整结束时使用该选项。

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

## v20 私有历史原页阅读回滚

- Production Worker predecessor：`55653436-b55a-4aef-986d-b11dbd84b36e`（v19/v46）。
- Preview Worker predecessor：`037df3d0-e192-4045-ad15-b7449dba2a28`。
- 源码 tag：`curriculum-baseline-20260724-v19-55653436`；backup branch：`backup/curriculum-v20-archive-reader-20260724`。
- D1、公开 metadata pointer 和远端 OCR 未改。回退先恢复 v19 Worker，再移除两端 `historical-reader/current.json`；两端 predecessor 都是 `null`，immutable `release-88cd…` objects 保留，禁止删除整桶。

## v20 正式验收记录

- Production health 200、`cache-control: no-store`，Worker `c6fa8f68…`、release Git `18f7ef7…`，historical reader ready 461，corpus expected/actual/live 精确相等。
- `/compare` 与 `/sources` 真實瀏覽器均不再出現 `page_count` 例外；`/archive` 精確顯示 461 個 `/historical/` 入口並覆蓋 1902–2000。
- 1902「欽定蒙學堂章程」代表條目顯示掃描物理頁 15–18、統一用戶登入入口、原圖優先及 OCR 不可引文邊界；匿名 API 為 401。
- Preview v47 实测：桌面 1440×1000 ready 546.4 ms / draw p95 5.2 ms；手机 390×844 ready 493.5 ms / draw p95 3.4 ms；16/16 runtime 通過。Production 桌面與手機橫向溢出均為 0，console errors/warnings 為 0。

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
