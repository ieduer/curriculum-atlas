# 运维与八点验证标准

## 1. Source of truth

代码与生成规则：`/Users/ylsuen/CF/curriculum-atlas`。官方目录与本地扫描库存只进入 `data/*.json` 和 `.cache/` 研究区；D1/R2 是部署产物，不反向覆盖来源。本机 `data/ocr-queue.json`、OCR state、witness 与 audit ledger 仍是导入权威；DMITPro2 内层 Kali 的 `/home/suen/curriculum-ocr-offload/runs/20260716T0250Z-paddleocrvl16-canary` 只保存隔离的主 OCR staging，不能反向成为本机完成或引文状态。

## 2. Health probe

`GET /api/health` 必须为 200、`ok=true`、`schemaVersion=3`、`classificationSchemaVersion=1`，分类覆盖须为 196/196：160 份学科资料、16 份课程资料、20 份范围/框架资料、`unclassifiedDocuments=0`，且 D1、R2、APIS、User Center、Assets 五项绑定均为 true。分类表采用加法子 schema，不提升全局 schema；因此发布后仍可直接回滚到 v4 Worker，而无需为代码回滚同步恢复 D1。

远端 OCR 健康不能只看 systemd 为 active：llama 必须由 `--llama-systemd-unit` 指向的精确 user unit 在 loopback `/v1` 提供服务；`curriculum-ocr-offload@a` 与 `curriculum-ocr-offload@b` 各自的 `run-identity.json` 必须与父/分片 manifest、runner/OCR 脚本 SHA、模型、mmproj、llama commit、runtime device 和并发配置完全一致，`run-status.json` 及其 SHA sidecar 必须有效。任何 invocation error、monitor incident、signal 或非零 child exit 都必须先重新验签 llama unit/process/binary/model/flags/health、Python/Paddle 包和稳定模型缓存；共享身份漂移必须写 `shared_runtime_configuration` 并 exit 2，不能消耗文档重试或隔离预算。运行期允许 `running` / `retry_wait`；最终成功要求两个 shard 的全部文档均为 `complete`，不存在 `pending`、`running`、`retry_wait` 或 `quarantined`，且逐卷页集与哈希重新验签通过。本机 watchdog 在远端 staging 期间保持 `hold`，且不得存在本机 drain 或 Paddle owner。

## 3. Contract check

- `/api/meta`：文档、段落、可引文文档及在线核验数量与生成清单一致。
- `/api/search`：仅返回文档和段落双重白名单内容。
- 历史扫描详情：文档级保持 fail-closed，但已核验单项显示版次关系、证据 URL、图像/OCR 哈希与处理结论。
- `/api/source-manifest`：R2 对象存在并带 ETag。
- 未登录 AI 返回 401；无 Turnstile secret 的匿名讨论返回 503，不可 fail-open。
- 远端 manifest 已逐卷核验 72 份完全未开始文档、5,483 页、2,017,324,713 源字节；14 份存在本机完成、retry 或 state 冲突的文档被排除。
- 父 manifest SHA-256 为 `3050f22e7bda3cb5aafb1817bc861b7f7b8d65e358dbbba3b5a0b35af4b27c8f`；shard `a` 为 36 卷/2,771 页/1,072,093,739 bytes、SHA-256 `a532240cf6d9deeec2843997156afa38fa2518f24d976d625769cec3765fcc9b`，shard `b` 为 36 卷/2,712 页/945,230,974 bytes、SHA-256 `744a50b84920dbed0d62d41318af71ca90a420f073c4322d04e501948eee075c`；两者文档集合必须不相交，合并后必须精确等于父 manifest。
- 远端导入只接受本机仍为 0 页完成的整卷：源 SHA/字节数/页数一致，页集恰为 `1..page_count`，每页 result/Markdown 均可重新计算并匹配 state 哈希，且所有页保持 `citation_allowed=false` / `citation_eligible=false`。远端 `rendered_image_sha256` 是识别当时临时页图的记录值；当前不保留该临时页图，不能把字段格式检查误报为图像重验。
- 任一来源、身份、配置、页集或产物门失败即拒绝整卷；远端完成后仍须在 Mac 上从原 PDF 重新生成 MuPDF 240 DPI 页图，记录新图像哈希，完成盲 Apple Vision、exact audit、图/OCR 互证和同版在线文本核查。只有这一层重渲染才构成可复查的图像证据。

## 4. Deploy and forbidden actions

发布命令见 `docs/deployment.md`。禁止直接编辑 D1 生产文本、把扫描件整体放入公开 R2、用新版本覆盖历史措辞、绕过 `apis` 直连 Gemini、在共享枢纽脏工作树未核对时夹带部署。远端 OCR 不构成网站发布；禁止保存 SSH 密码、把 llama 暴露到非 loopback、导入部分卷、绕过 Mac 见证、复用身份不一致的 output root，或让 systemd 重启永久配置错误和 terminal quarantine。

## 5. Dependency regression

发布后检查：

- `my.bdfz.net/api/session` 的同源认证路径。
- `nav.bdfz.net/sites.json` 中 `curriculum.bdfz.net` 唯一。
- Companion URL 策略测试通过。
- Pulse 能把 Worker `bdfz-curriculum-atlas` 映射到 `curriculum.bdfz.net`。
- APIS health 可用，AI 回答引文不越界。
- 远端运行前后核对内层工作站既有视频、OmniVoice/GPU 和其它非任务服务未被停止；OCR 只使用任务隔离的 user-systemd unit、run root 和 loopback llama。

## 6. Backup and restore

D1 依赖 Time Travel；发布前记录书签。代码进入 Git，未公开 PDF 保留本地原文件与 SHA-256。R2 只保存可重建的 JSON 元数据。讨论是用户数据，任何重建都必须保留 `comments`、`comment_reports` 和审计表。远端 OCR 的恢复证据是 Git 备份分支、父/分片 offload manifests、源 bundle、模型/mmproj/llama commit、每个 shard 的 run identity、逐卷 status/hash sidecar 和隔离 run root；`r1` 至 `r5` 的完成/部分页状态均保留，pre-r5 远端备份为 `backups/pre-r5-provenance-lock-20260716T0635Z`。它们不能替代本机原 PDF 与既有 OCR/witness/audit ledger。

## 7. Rollback

Worker、D1、R2 和五个公共注册表面的回滚方法见 `docs/deployment.md`。语料增量导入使用 `ON CONFLICT ... DO UPDATE`，禁止使用会级联删除评论的 `INSERT OR REPLACE INTO documents`。远端回滚先依次 `systemctl --user stop curriculum-ocr-offload@a curriculum-ocr-offload@b` 与 `systemctl --user disable curriculum-ocr-offload@a curriculum-ocr-offload@b`，再停止/禁用 `curriculum-ocr-gpu-monitor` 和已核 owner 的 `curriculum-ocr-llama`；如需回退 r5，再从 `backups/pre-r5-provenance-lock-20260716T0635Z` 恢复精确 unit/scripts 并执行 `systemctl --user daemon-reload`。旧 singleton `curriculum-ocr-offload` 保持 disabled。不删除 r1–r5 已生成证据，不改本机 ledger。配置变化使用新 output root。每个 offload instance 必须配置有界 start limit 与 `RestartPreventExitStatus=2 12 75`：`2` 为永久启动/配置错误，`12` 为 terminal quarantine，`75` 为人工中断。

## 8. Last verified

每次发布在 canonical Cloudflare report 和 `agent_action_log.jsonl` 记录：时间、Worker 版本、D1 schema/counts、R2 ETag、API/浏览器证据、User Center 写入回查、Pulse 覆盖、回滚锚点与未解决风险。

最近一次验证为 2026-07-15：生产 Worker 保持 `7d1766b2-32be-4ce1-9528-f6c69bb2a092` / `2026.07.15-v7`，立即回滚锚点为 `b91d1d29-6f10-49a3-ab40-e4f84af76256`；预览 Worker 已更新为 `2459045b-9337-477e-af09-571bcd91dcab` / `2026.07.15-v8`，入口为 `https://bdfz-curriculum-atlas-preview.bdfz.workers.dev`，立即回滚锚点为 `55cf188f-b794-4ec5-ab8d-b25ab39f8351`。两端 `/api/health` 均为全局 schema 3、分类子 schema 1、196/196 完整分类：160 份学科资料、16 份课程资料、20 份范围/框架资料、0 未分类，五项绑定全真。本次预览只更新 Worker/Assets，未改生产、D1 或 R2；D1 仍为 196 份资料、16,456 段、103 份可引文资料、0 条公开评论和 1 条在线核查，`/api/compare?subject=语文` 返回 10 份版本文献和 3 条编辑洞见。由于本机系统级文件描述符故障阻断真实浏览器启动，v8 只完成静态合同与 API smoke，尚未满足本文件要求的桌面/移动实机视觉门，因此不得推进生产。

OCR 远端 staging 最近一次可声明验证为 2026-07-16：既有 Ed25519 公钥已交互式安装到内层 `suen`，通过 `dmitpro2` 跳板的 `BatchMode=yes` 返回精确 hostname/user；密码未写入命令、文件、报告或日志。Kali CUDA 的 `parallel=4` 五页基准连续三次均为 68/70，三次 JSON/Markdown 均与远端 `parallel=1` 逐字节一致；同一 16 页 `micro_batch=16` 约 68 秒，快于 `micro_batch=8` 的约 86 秒，两者 Markdown、render hash 和 canonical JSON 一致。单 worker 首卷 39/39 页用时 231.720 秒（10.10 pages/min）；双 worker canary 32/32 在 94.321 秒内完成（20.36 combined pages/min），两份 Markdown、rendered hashes 与 canonical JSON 均精确等于 sequential MB16 baseline。72 卷父 manifest 保持 5,483 页/2,017,324,713 bytes 的精确不相交并集。r4 有意停于 A 529 + B 426 = 955 个完成页、2 个失败页、0 restart；文档与 cache 逐字节迁移到 r5，A/B tree SHA-256 分别为 `2d4e49f37e26fc1cc98263e61537cdb162c66a70462f88ec9db3f1f8f52fe9bf` / `fd0372647993f67cb0e1d28b4db8145ec7f725b8d1bb9e3bde81d4493854e5e6`。r5 固定 runner `8d19a7b0cc1f619b492fb7b94fd7c96a7f5e83098e185479e1de645866ae9565`、OCR `b4ea873026fb4d2da2efb921ddac3974a48db703143ff53aff3ebeae48d9b048`、planner `4b248524ccabb16ca272e95592b3ac21b968b6ecebccae56874823ab2edca4dd` 与 runtime fingerprint `a45041b1bcae6a764698e4cc61b6ae8a33c3ba00135d099ff82c027ed2888a76`，并在 `2026-07-16T06:40:01Z` 启动。`06:49:37Z` 快照为 A 577 / B 453，共 1,030/5,483 完成页；仅俄语实验标准第 40、72 页保持 PEG-native fail-closed，文档为 `retry_wait attempts=1`，两 shard 已继续健康文档。两 run-status sidecar 和逐卷 state/pages 一致性均通过，A/B/llama/monitor 全部 active、`NRestarts=0`。本地 Node 112/112、Python 12/12，远端 Node 38/38、Python 12/12 通过。本机 watchdog 保持 `hold`，本机 1,464 页主 OCR/exact audit 与 1,529 页 Vision 账本不变。以上仍是不可引文 staging，不声明全语料完成、远端导入或网站发布。

预览概念模型为 560 个概念观察点（553 个可引文、3 个图文复核但不可逐字引用、4 个 OCR 候选）、475 条词面观察关系、7,836 个版本内出现记录和 5,235 条完整证据。核心 JSON 为 3,860,085 bytes、SHA-256 `b5a17e291bc3a45f683bcd497ae4676709d6d6e4321188d31a8a6c378bef48e0`；完整学术模型为 22,013,686 bytes、SHA-256 `1e95a2ca181b0fe2071cfb90483af146e2de7e72fc096e5a805fe23d82b1eb93`；本地与预览一致，build revision 为 `7d06a9b48a12a23b67ede054ddafb5da9208f50d3a6d9cab64df6752c6d39f64`。完整学术模型保持全部字段低于 Cloudflare 单资产 25 MiB 限制，仍只作按需研究资产，首屏不会下载；生产 v7 继续保留上一版图，不能把预览数据误报为已生产发布。

学术身份与星图展示已分层：D1/API、taxonomy、stable ID、官方代码和版本证据保留 29 行精确学科名称；星图竖列只显示 12 个组，不再显示冗余“全部学科”。普通点击隔离单科，再点唯一激活学科恢复全部，Shift 可多选。每个 episode 的 `visibility_facets`/`visibility_policy` 只允许直接受控学科或经审核课程关系进入单科视图；全 12 科隔离回归确认语文不再出现综合康复的“运动能力”，艺术等同名词也不跨课程语境泄漏。

预览语文 `概念深挖` 星图已扩展为 169 个 edition-scoped 节点、3 个版本范围、21 个官方证据锚点和 175 条结构/经核关系。一级可进入语言文字运用、三维目标、核心素养、语文实践、18 个学习任务群和学业质量；继续展开 34 个官方术语、21 条能力描述、38 条任务要求、5 类语言活动、3 个历史目标维度、4 个核心素养维度、12 项课程目标、15 项学生能力与 5 个质量等级。学业质量表格细目在完成逐行视觉重组前继续 fail-closed，`performance_indicator` 仍为 0。前端将学科、检索和谱系收进左轨，将纵向年代、版本资料和研究讨论收进右轨；单学科普通点击按可见节点自动适配且上限 `1.32`，Shift 多选保留用户镜头，非语文学科进入概念深挖时保持本学科并 fail-closed，不再暗切语文。74 项 Node 测试、TypeScript、构建、概念校验、Wrangler dry-run、预览静态/API smoke 和 `git diff --check` 均通过；真实浏览器视觉项仍按上一段保持未完成。

OCR 覆盖审计新增本机缓存的教育部 2011/2022 义务教育标准 36 份、3,157 页；每份均核验 PDF 签名、页数、SHA-256 和无可用原生正文，且固定为 `ocr_required`、`citation_allowed=false`。队列由 50 份/8,690 页扩大为 86 份/11,847 页，语文 2011/2022 两版列为优先级 0。旧队列在完整 64 页批界进入 hold，经精确 PID/cwd/命令/锁核对后平滑释放并恢复 run，未中断 Paddle 页处理，也未重做已通过哈希与审计的页面。

OCR 严格快照（2026-07-15 15:23:42 UTC）为 1,228/11,847 页 exact 审计完成、10,619 页待完成质量闭环、0 失败；主 OCR 已完成 1,231 页，Apple Vision 见证 1,273 页，差值来自当前在途批次，完成页缺见证、错误 sidecar、过期审计、重试和隔离均为 0。1,228 个已审计页中 357 页待图像复核、11 页待空白确认、860 页 unresolved fail-closed、0 页自动引文放行。2011 年版义教语文已 83/83 完成且零失败；当前正在处理 2022 年版义教语文 65–109 页。watchdog 为 `observing_active_owner`，三路并发、llama health 与心跳正常，磁盘约 97.2 GiB。

并发基准在同一组 5 个已人工核锚点页面上比较 `parallel=1/2/3/4`：四组均为 68/70（0.9714），`parallel=3` 输出与 `parallel=1` 五页逐字节一致，用时由 45.982 秒降至 35.061 秒（快 23.75%），`parallel=4` 反而回退至 46.389 秒，因此生产固定为 3 路并发、每槽 8,192 context、`vl_rec_max_concurrency=3`。随后英语卷与小学综合卷两个完整 64 页批次分别用时 783.252 秒和 844.918 秒，128/128 主 OCR、Vision 见证、exact 审计全部齐全且零失败；计入 2.586 秒交接后，端到端吞吐为 4.709 页/分钟，即 47.09 页/10 分钟。按该实测吞吐，扩容后剩余 10,619 页约为 37.6 小时；扫描复杂度会使 ETA 浮动。跨引擎质量基准保留在 `data/ocr-benchmark-results.json`，本轮并发选择和完整批次验收另存 `data/ocr-throughput-benchmark-results.json`，避免覆盖历史证据。OCR 页仍全部 `citation_allowed=false`，机器排空不替代逐页图像、独立识别和同版在线文本的编辑核查。

OCR 长任务由 `scripts/ocr-supervisor.mjs` 监管；`npm run ocr:check` 提供机器健康码，`npm run ocr:status` 查看锁、心跳、磁盘、见证、审计、复核和概念图覆盖。退出码合同为：`0` 健康、`2` 退避/局部隔离、`10` 运行或页/见证失败、`11` 停滞、`12` 全局硬停止、`75` 正在运行且锁归属有效。`npm run ocr:recover` 是显式绕过非隔离退避的单页恢复探针；它绝不绕过 quarantine。

可见的 Codex automation `Curriculum OCR quality supervisor` 已暂停，其产生的 6 个历史任务已归档。本机 LaunchAgent `com.suen.curriculum-ocr-watchdog` 通常以 `scripts/ocr-watchdog.mjs` 每 15 秒核对 drain PID、命令、cwd、锁和心跳；只有同一 owner 连续两次超过 180 秒无心跳才允许发信号，随后只做单页有界恢复。生产 fast path 是单例 64 页连续排空；Apple Vision 失败按 2、10、30 秒以新进程重试，缺失/过期审计只走 `audit_backfill`。低于 50 GiB 停止自动续跑，低于 25 GiB 硬停止；未知进程不清理，失败页不放行。单页/单文档隔离不会阻断其他合格任务；共享 runtime、模型校验和、磁盘才是全局阻断。当前因本机 native runtime 故障及整卷远端导入门，watchdog control 明确为 `hold`，无本机 drain/Paddle owner；只有本机一页 native runtime canary 通过且远端卷归属已裁决后才能恢复 `run`。

LaunchAgent 模板为 `ops/launchd/com.suen.curriculum-ocr-watchdog.plist`，当前安装在 `~/Library/LaunchAgents/`。`npm run ocr:watchdog:status` 查看 watchdog 自身状态，`npm run ocr:status` 查看严格队列状态；正常运行时前者应每 15 秒刷新 `observing_active_owner`，不能长期停在 `starting_drain`；当前受控状态应显示 hold 且没有 owner。回滚先以 exact PID/cwd/lock 确认 owner，再 `launchctl bootout gui/$(id -u)/com.suen.curriculum-ocr-watchdog`；不得用 broad `pkill`，也不得删除已经通过哈希和 exact audit 的页面。

### OCR renderer 与 macOS 启动故障

Apple Vision 的生产页图固定由 MuPDF `mutool` 1.28.0 以 240 DPI 渲染；路径为 `/opt/homebrew/bin/mutool`，允许的 SHA-256 为 `b7ee6e71e5453afd4d730bcc8ba38128a89a9b550f2e7dab8effacd46634e9c6`。主 OCR preflight 会把 renderer、GGUF 和 mmproj 一起做完整性校验。日常只读核对：

```bash
/opt/homebrew/bin/mutool -v
shasum -a 256 /opt/homebrew/bin/mutool
npm run ocr:watchdog:status
npm run ocr:status
```

2026-07-16 发现的本机 Poppler 停滞不是 PDF 内容错误：`pdftoppm` 尚未打开 PDF 就停在 dyld `fcntl`，同时 `syspolicyd` 日志反复出现 `UNIX error 24`、`Failed to generate SecStaticCode`，属于系统文件描述符耗尽。本机 supervisor 的独立见证渲染已不再依赖 Poppler；MuPDF 单页渲染上限为 30 秒，并每 30 秒刷新 owner heartbeat。超时只结束精确 child，写入 `CAPTURE_TIMEOUT` 并释放锁。本机 Paddle 主识别使用独立边界：启动 180 秒、连续无进展 300 秒、批次总时长取 20 分钟与每页 25 秒两者较大值；只有任务日志或 `state.json` 更新才算进展。越界时仅向精确 child 发 `SIGTERM`，五秒后仍为同一进程才发 `SIGKILL`。Kali offload 使用本节另行规定的 15 秒 TERM grace。不要由 OCR 自动化重启 `syspolicyd`，也不要用 broad kill；若 MuPDF、Python 或其他 Homebrew 可执行文件仍停在 `_dyld_start`，先把它报告为系统 runtime-launch 故障，保持 OCR fail-closed，再由人工运维窗口处理系统服务。

Paddle 子进程被信号结束、超过上述边界，或日志出现系统策略拒绝 `dlopen`、`EMFILE`/`ENFILE`、`libpaddle` 原生模块未载入时，统一记为 `PADDLE_RUNTIME_UNAVAILABLE`：watchdog 按 `runtime_retry_at` 退避五分钟，不能累计到任何页的五次隔离额度。历史上被这类运行时故障误写为通用 `PADDLE_PAGE_FAILED` 的记录，先运行 `node scripts/ocr-supervisor.mjs reconcile-runtime-retries` 查看候选；仅在无 batch owner 时运行带 `--apply` 的同一命令。它只删除同时被 run history 和对应 Paddle 日志证明的通用记录，保留真实内容错误，并先复制一份精确 retry ledger 备份。

### DMITPro2 Kali CUDA 主 OCR staging

DMITPro2 内层工作站只可承担独立 staging 的主 OCR，不能替代本机 Apple Vision 见证。既有 Ed25519 公钥现已交互式安装到内层 `suen`，并通过跳板链路的 `BatchMode=yes` 校验；密码仍不得写入脚本、命令、Git、报告或日志。远端使用固定 llama.cpp commit、模型/mmproj SHA、Python/Paddle 版本和 240 DPI 页面合同；llama 只监听 loopback，并由 runner 核对精确 user-systemd unit MainPID、可执行文件、模型参数和 `/proc` 进程归属。

`scripts/plan-remote-ocr-offload.mjs` 已选出并在 Kali 重验 72 个完整未开始文档、5,483 页和 2,017,324,713 bytes。父 manifest SHA-256 为 `3050f22e7bda3cb5aafb1817bc861b7f7b8d65e358dbbba3b5a0b35af4b27c8f`；精确且不相交的 shard `a` 为 36 卷/2,771 页/1,072,093,739 bytes、SHA-256 `a532240cf6d9deeec2843997156afa38fa2518f24d976d625769cec3765fcc9b`，shard `b` 为 36 卷/2,712 页/945,230,974 bytes、SHA-256 `744a50b84920dbed0d62d41318af71ca90a420f073c4322d04e501948eee075c`。`scripts/run-remote-ocr-offload.mjs` 在 `curriculum-ocr-offload@a` / `@b` 内各自逐卷串行调度，卷内使用已验证的 `parallel=4` / `micro_batch=16 --use-queues`。queued 调用或完整 `input_path` 映射失败时，不提交任何批结果，并对该批逐页重跑及再次严格验签路径；这使单个 PEG/VLM 错误不能污染其余 15 页。有效部分页可以保留，但未完整的卷不可导入；每卷最多五次，按 2/10/30/60 秒进入 `retry_wait`，矛盾状态或耗尽预算进入 `quarantined` / exit 12。每个 instance 都必须阻止 exit 2/12/75 自动重启并设置有界 start limit。

远端回传只接受本地仍为 0 页完成、身份与逐页哈希全过门的整卷。导入后仍须在 Mac 上运行 MuPDF 240 DPI、盲 Apple Vision、exact audit 和同版官方/学术在线文本核查。任何远端页始终 `citation_allowed=false`，不得直接进入 D1、R2、概念正式图、AI 引文或公开网站。

恢复任务会先核对已有图像和 Apple Vision sidecar 的文档、物理页、PDF SHA 与图像 SHA；四者一致就复用，不为重试主 OCR 重做见证。仅有 `PAGE_QUARANTINED`、scheduler=`ready` 且存在下一批时，隔离页不会阻断其余页面；任何文档隔离、模型/renderer 校验失败、见证错误、磁盘或 ownership 问题仍全局停止。

严格恢复快照（2026-07-16 01:09 UTC）：队列 86 份/11,847 页，主 OCR 与 exact audit 均为 1,464 页；Apple Vision witness 为 1,529 页，error sidecar、完成页缺见证和 stale audit 均为 0。新增 64 个 witness 是语文汇编物理页 32–95 的 MuPDF/Apple Vision 成功，不是主 OCR 完成。该批的 Paddle Python 子进程仍受系统 dyld 启动故障影响，64 页只进入可重试退避而未隔离；化学汇编第 84 页保持单页 Paddle quarantine。恢复完成必须看到主 OCR、witness 与 audit 再次形成逐页闭环，不能只看 witness 数增长。

远端第一次生产启动 `r1` 在接受页面前暴露 venv realpath 与 shared-probe 分类问题：启动器调用了解析后的解释器目标，而不是 virtualenv 的词法入口，并把共享 probe 失败误写为 72 条 `attempts=0` quarantine status。该轮实际为 0 pages / 0 artifacts；`run-identity`、status 和日志保留为故障证据。修复后的 runner 同时记录 invocation path 与 resolved target，但只通过词法 venv 路径执行；任何 shared probe failure 现在都在修改文档状态前 exit 2。

修复后的单 worker `production-p4-mb16-r2` 首卷 39/39 页以 231.720 秒完成（10.10 pages/min），第二卷处理 16 页后为经过等价验证的双 worker 切换而主动停止；保留状态为 complete 1 / interrupted 1 / pending 70 / quarantined 0。81 个监控样本显示 GPU 平均 36.6%，大于等于 80% 的样本占 38.3%、idle 占 61.7%，定位到 CPU layout 气泡。双 worker 金丝雀对同一 16 页各执行一次，以 94.321 秒 upper wall 完成 32/32、0 failures、20.36 combined pages/min；两份 Markdown、rendered hashes、canonical JSON 均与 sequential MB16 baseline 精确一致，两个 Python 进程约占 11 个 CPU cores，GPU 使用仍有界。

第一版双 shard 于 `2026-07-16T04:35:27Z` 启动；最终 fail-closed 审计发现整批映射、共享 runtime 分类、版本/缓存指纹、运行期 sidecar 与 child 停滞边界仍需收紧，因此只停止 `@a` / `@b`，精确返回人工中断 exit 75，并在 278 个候选页、0 failed page、0 quarantine 处保留 r1。修复后，队列必须先验证完整 `input_path` 集合才提交任何页；runner 在文档状态写入前初始化 PaddleOCR-VL，固定 CPython 与 PaddlePaddle/PaddleOCR/PaddleX/pypdfium2 版本、稳定 `official_models` 缓存树、240 DPI 和完整 worker 参数。独立的零文档初始化 probe 有 15 分钟进程硬上限，用于首次模型/缓存初始化，且仍发生在任何文档状态写入前；它不等同于文档 child 的启动计时。`run-status.json` 每次写入同步更新 sidecar，恢复先验签；文档 child 启动/无进展/总时长分别受 180 秒、300 秒与 `max(20 分钟, 25 秒×文档页数)` 限制，15 秒内按精确 TERM→KILL。runner 自身 SHA 进入不可变 identity；任何 invocation/monitor/signal/nonzero child failure 都先重验共享 runtime，失败即 exit 2，不进入文档隔离。

r1 保持不变；其文档状态复制到新 `production-p4-mb16-shard-a-r2` / `-b-r2` 后逐字节核验，A tree SHA-256 为 `8f57814225db7a466c0cfe6e4c87a8007f7aa0f431f22da8df6227058b50fc23`，B 为 `6bea6bca75be974ddd2b75fa14fc371f1ed4f8e9ba0291aba0719ad7b49c2e42`。新双 shard 于 `2026-07-16T05:10:30Z` 启动；identity 固定 CPython 3.13.12、PaddlePaddle 3.3.1、PaddleOCR 3.7.0、PaddleX 3.7.2、pypdfium2 5.12.0，以及 17 个稳定模型文件/171,142,109 bytes，A/B runtime fingerprint 均为 `a45041b1bcae6a764698e4cc61b6ae8a33c3ba00135d099ff82c027ed2888a76`。r2 在 `05:27:33Z` 以人工 exit 75 停于 A 243 + B 237 = 480 页，0 failed page、0 quarantine、0 restart；这次暂停用于补齐运行中 shared failure 与 runner SHA 门，不是 OCR 内容失败。

r2 文档与 cache 原样复制到 r3；r3 identity 固定 runner `873cf9cc4ebecc4811dc1ffba0b5b9f0456814ee66bc08cf930767bfe438acf9`、OCR script `04fce55829896a4ecd829d28dcc9c18c2c400a3ba7face2d8d0cde07989a154a` 和相同 runtime fingerprint，并于 `05:36:54Z` 启动。验收期间 A 增至 259 页且 0 failed；B 的一个 queued call 因同一 PEG-native parser 500 把物理页 33–48 误扩成 16 个 failed marker。两个 shard 于 `05:41:06Z` 立即以 exit 75 停止，0 restart、0 quarantine、无残留 OCR owner。隔离 P1 随后在同一 240 DPI/Paddle/llama identity 下逐页重跑：33–39、41–48 共 15 页成功，只有物理页 40 稳定复现同一 PEG 500；llama 始终 active、健康且 0 restart，因此不能把它误报为共享服务崩溃。

r3 的文档与 cache 状态复制到新的 r4 根并逐字节核验，A/B tree SHA-256 分别为 `70a73415954b4fed3aa8c2346388f811968fc002a498410db089d30680b57bd2` / `07fa00db3e2a23f91429e1de3838ac9c433a646b3254dca6c528c3e496acc27d`。r4 于 `2026-07-16T05:53:10Z` 启动，identity 固定 runner `399241840dde169cc3b63eb21725f6a0d1bb3378fd60a85c15f8b39b3543f8ca`、OCR script `abf9f6456227514a3e764ed20a8180fd6cab62e01ccddd99ed8ff7f86b339819`、原 manifest 与 runtime fingerprint。Kali runner+microbatch tests 22/22、Python 11/11，本地全套 100/100，`node --check`、`py_compile` 与 diff check 均通过。r4 会把失败批逐页验签并继续其他文档；页 40、72 与所在整卷在得到可核替代识别前继续 fail-closed。该卷 94/96 页完成后 child exit 1；runner 完整重验共享 runtime、写入 `retry_wait` 并自动进入下一份健康文档。截至 `2026-07-16T06:16:31Z`，A 401 页 / 0 failed，B 299 页 / 2 failed，总 staging 700 页；两 status sidecar 验签通过，A/B/llama/monitor 全部 active 且 0 restart。所有远端页仍只是不可引文 staging，不构成 corpus completion、Mac ledger import、D1/R2 更新或网站发布。

r4 在 A 529 + B 426 = 955 个完成页、2 个失败页、0 restart 处以人工 exit 75 停止。最终审计把 output-root owner lock 前置到任何 cache/probe/identity/status 操作之前，补齐所有 child failure 后的 runner/OCR/llama/Python/cache 全量复验，使共享故障不消耗文档 attempt，并关闭 signal-before-child-registration 竞态。planner 现在对存在但为 null/非对象/非法或不支持 schema 的 state fail-closed，并对项目、queue、cache、source、output 做 lexical 与 realpath/最近存在父目录校验。OCR 已记录失败页时只对该页直接严格单页重试，后续干净批仍保持 MB16。r5 从 r4 逐字节迁移，A/B tree SHA-256 为 `2d4e49f37e26fc1cc98263e61537cdb162c66a70462f88ec9db3f1f8f52fe9bf` / `fd0372647993f67cb0e1d28b4db8145ec7f725b8d1bb9e3bde81d4493854e5e6`，并固定 runner `8d19a7b0cc1f619b492fb7b94fd7c96a7f5e83098e185479e1de645866ae9565`、OCR `b4ea873026fb4d2da2efb921ddac3974a48db703143ff53aff3ebeae48d9b048`、planner `4b248524ccabb16ca272e95592b3ac21b968b6ecebccae56874823ab2edca4dd`。`2026-07-16T06:49:37Z` 快照为 A 577 / B 453，共 1,030/5,483 完成页，2 failed；两 sidecar 及 21 个 state/pages 映射全部一致，四个 user units active 且 `NRestarts=0`。

页 40 与 72 的原始生成包含确定性孤立 byte token，llama.cpp 在 PEG-native chat 解析阶段返回 500；这不是共享 llama/Paddle 失活。运维上不得用 `--skip-chat-parsing`、raw completion 的 U+FFFD 替换或手工猜字把它伪装成成功。保持当前 r5 双分片继续处理其余页面；故障页保留原图、错误、字节与哈希证据，之后用另一可追溯识别后端重跑，并完成 Mac 图像/Apple Vision/同版在线文本核查。任何替换字符或版本不明文本都继续不可引文。

Paddle 异常退出后仍重读 state，保留部分成功页，并为每个未完成页补齐 retry。Apple Vision sidecar 必须具备文档、页码、PDF 和图像 SHA；主 OCR 内容与 result 文件在进入审计前重新核对 state SHA。概念候选写入版本化 run 目录，只有 graph/quality revision 匹配且验证通过后才原子切换单一 manifest；保留当前和前一 last-good。保持已发布图和 Git 工作树不变；禁止自动部署、导入 D1、写 R2、提交或推送。只有人工证据复核和正式 `npm run concepts:build` 才能更新可发布图。

2026-07-15 故障恢复验证：`legacy-compendium-chinese` 1–4 页原 Apple Vision `nilError` 已分别通过 Vision、Paddle、页级审计恢复；10–20 页 11 份缺身份哈希的旧见证已重建。一次为切换并发参数而由精确 owner 发出的 SIGTERM 已保留中断记录，随后 16 页 p3 金丝雀及两个完整 64 页 p3 批次全部通过；当前错误 sidecar、完成页缺见证、Paddle 失败页、过期审计与隔离均为 0。15 页仍为 `unresolved_fail_closed`，属于内容质量门而非运行故障，不进入引文；后续连续排空的当前数字以上方带时间快照为准。

## 日常检查

- 每周：失败 OCR 队列、未核验冲突、匿名讨论待审核、AI 引文失败、Worker 错误率。
- 每月：官方目录与修订动态复查、来源 URL 可用性、R2 清单与本地 SHA 对账。
- 扫描件每次新增或更换：重算源 SHA、重新准备 OCR 队列，不继承旧页的通过状态。
- 自动监控只推进 OCR 与本地概念图候选更新；任何节点升级为可引用、进入正式关系或上线仍须人工证据门与发布验证。
- 日志只保留服务、版本、路径组、状态和错误类别；不写 cookies、session、原始研究问题或学生内容。
