# OCR quality and version-aware online verification

## Decision

The production primary is the official PaddleOCR-VL 1.6 document pipeline: PP-DocLayoutV3 detects regions and reading order, then the official PaddleOCR-VL-1.6 model recognizes each region through the pinned llama.cpp backend. The Mac Metal profile remains the local primary and the only host for the independent Apple Vision `accurate` witness; the DMITPro2 inner Kali workstation may run the same pinned primary pipeline through CUDA only as isolated, non-citable whole-document staging. PP-StructureV3 with PP-OCRv5 is the adjudication engine for disputed characters and coordinates. Tesseract is retained only as a diagnostic baseline because it did not meet the benchmark threshold.

Official technical references:

- [PaddleOCR documentation](https://www.paddleocr.ai/latest/en/index.html)
- [PaddleOCR-VL pipeline](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/PaddleOCR-VL.html)
- [PaddleOCR-VL on Apple Silicon](https://www.paddleocr.ai/main/en/version3.x/pipeline_usage/PaddleOCR-VL-Apple-Silicon.html)
- [PP-StructureV3](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/PP-StructureV3.html)
- [PaddleOCR source](https://github.com/PaddlePaddle/PaddleOCR)
- [PaddleOCR-VL-1.6 model](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6)
- [Official GGUF model](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF)
- [OmniDocBench](https://github.com/opendatalab/OmniDocBench)

Pinned shared runtime and execution profiles:

- Mac project-local Python 3.13 environment: `.cache/venv-paddleocr`
- Kali isolated Python 3.13 environment under `/home/suen/curriculum-ocr-offload/runs/20260716T0250Z-paddleocrvl16-canary/venv`
- PaddlePaddle 3.3.1
- PaddleOCR 3.7.0
- PaddleX 3.7.2
- llama.cpp commit `12127defda4f41b7679cb2477a4b0d65ee6a0c8f`
- GGUF SHA-256 `f3ae46ec885050acf4b3d31944431e1fd90d50664fb09126af4a3c050ba14ee8`
- multimodal projector SHA-256 `204d757d7610d9b3faab10d506d69e5b244e32bf765e2bab2d0167e65e0a058a`
- MuPDF `mutool` 1.28.0 at `/opt/homebrew/bin/mutool`, SHA-256 `b7ee6e71e5453afd4d730bcc8ba38128a89a9b550f2e7dab8effacd46634e9c6`
- model repository revision `511b09642bb324401f15f97cc23bc67e8f0a291d`

The Apple Silicon-specific PaddleOCR guide was followed on the Mac: native Paddle installation, not the unsupported Docker path. The remote profile keeps layout and orchestration on CPU and offloads the pinned llama.cpp recognizer to the NVIDIA GeForce RTX 3060 Laptop GPU with 6 GiB VRAM; it does not alter the model, 240 DPI page contract or citation policy. `P4` in immutable run names means `parallel=4`, not the GPU model. MLX-VLM is not the production stack because it serves only the VLM stage and does not replace layout detection/read-order reconstruction.

## Local benchmark

Five visually reviewed pages cover normal prose, dates and page numbers, a historical title page, a dense two-column title/author catalog, and a current Ministry of Education standard. The metric is critical-anchor recall after NFKC and punctuation/whitespace normalization. It is not claimed as full character error rate.

| Engine | Critical anchors | Recall | Production role |
| --- | ---: | ---: | --- |
| PaddleOCR-VL 1.6 full layout pipeline | 68/70 | 97.14% | primary structured transcription |
| Apple Vision accurate | 58/70 | 82.86% | fast independent witness |
| PP-StructureV3 / PP-OCRv5 | 50/70 | 71.43% | disputed-character adjudication |
| direct whole-page PaddleOCR-VL | 42/70 | 60.00% | rejected: loses multi-column pairing |
| Tesseract 5.5.2 | 26/70 | 37.14% | diagnostic baseline only |

The decisive test was physical PDF page 567 of the Chinese compendium. Whole-page VLM output grouped titles and authors separately. The full Paddle pipeline reconstructed an HTML table and matched 28/29 catalog anchors, but misread `关汉卿` as `吴汉卿`. PP-Structure and a rerendered Apple Vision pass read `关汉卿`; official government/education sources independently confirm that authorship. The retained resolution record is `data/online-verification-samples.json`.

### DMITPro2 CUDA staging benchmark

The Kali CUDA profile was selected only after the same five-page anchor set passed three independent `parallel=4` runs at 68/70 anchors each. All five result JSON files and all five Markdown files were byte-equivalent to the remote `parallel=1` reference. This establishes deterministic equivalence for the benchmark, not citation eligibility for any corpus page.

Queued micro-batching was then tested on the same 16 physical pages with `temperature=0` and exact result-to-input path mapping. `micro_batch=16` completed in about 68 seconds versus about 86 seconds for `micro_batch=8`; the two runs had identical Markdown, rendered-image hashes and canonicalized result JSON. The remote staging profile therefore uses llama `parallel=4`, `vl_rec_max_concurrency=4`, `server_parallel=4`, `micro_batch=16` and explicit `--use-queues`. These bounded canaries are not a final whole-corpus throughput claim.

The first single-worker production baseline, retained as `production-p4-mb16-r2`, completed its first document at 39/39 pages in 231.720 seconds, or 10.10 pages/minute. Telemetry across 81 samples averaged 36.6% GPU utilization; 38.3% of samples were at or above 80%, while 61.7% were idle. The sawtooth proves that CPU layout/read-order work leaves recoverable bubbles around the bounded GPU recognizer; it is not evidence that the model or page gates should be weakened.

A two-worker concurrent canary therefore processed the same 16-page input independently in both workers. The pair completed 32/32 page executions with zero failures in an upper wall of 94.321 seconds, or 20.36 combined pages/minute. Both workers' Markdown, rendered-image hashes and canonical JSON were exactly equal to the sequential MB16 baseline. The two Python processes used about 11 CPU cores in aggregate while GPU use remained bounded. This validates two isolated document workers for staging throughput; every page still passes the same deterministic-content and import gates.

A final fail-closed audit then paused only the two shard units at 278 staged pages, with zero failed pages and zero quarantined documents. The queued recognizer now validates the complete `input_path` result set before committing any page; a duplicate, unknown, malformed or missing mapping rejects the whole micro-batch. The hardened runner probes PaddleOCR-VL initialization before document-state mutation, pins CPython plus PaddlePaddle, PaddleOCR, PaddleX and pypdfium2 versions, fingerprints the stable PaddleX `official_models` tree, requires exactly 240 DPI, and verifies a SHA-256 sidecar for every `run-status.json` recovery. That separate zero-document initialization probe has a 15-minute hard process ceiling so first-time model/cache initialization cannot be confused with document progress; it still runs before any document status is written. Each owned document child has a 180-second startup bound, a 300-second no-progress bound and a wall bound of `max(20 minutes, 25 seconds × document pages)`; timeout or monitor failure sends exact `SIGTERM`, waits 15 seconds and then sends exact `SIGKILL`.

The original shard roots remain immutable evidence. Their 278 staged pages were copied into new `r2` roots and verified byte-for-byte before the new identity was created: shard A's document tree is `8f57814225db7a466c0cfe6e4c87a8007f7aa0f431f22da8df6227058b50fc23`; shard B's is `6bea6bca75be974ddd2b75fa14fc371f1ed4f8e9ba0291aba0719ad7b49c2e42`. Both hardened units started at `2026-07-16T05:10:30Z`; by `05:16:25Z` shard A had advanced its partial document from 32 to 64/75 pages, while shard B had completed its 32/52-page partial document and committed 16 pages of the next document. The total reached 346 staged pages, with both run-status sidecars valid, zero failed pages, zero quarantine and zero restart. The 68 new pages over the startup interval include the full runtime probe and copied-state validation; the most recent steady window was about 13.0 pages/minute. This is a liveness and recovery sample, not a corpus-completion or citation claim.

A second audit stopped only the two `r2` shard units with intentional exit 75 at shard A 243 pages plus shard B 237 pages, or 480 staged pages total. Both had zero failed page, zero quarantine and zero restart. This stop closed the remaining case in which a real mid-run llama/Paddle/cache failure could surface as ordinary child exit 1 and consume a document retry budget. The runner now pins its own SHA-256 in immutable run identity. After any monitor incident, signal or nonzero child exit, it re-attests the exact llama systemd/process/binary/model/flags/health identity, re-probes the pinned Python and four OCR packages, and re-fingerprints the stable PaddleX cache before allowing a document retry. Any mismatch writes a sidecar-protected `shared_runtime_configuration` failure, exits the shard with code 2, leaves untouched documents pending and never quarantines the current document as a content fault.

The `r2` document and cache states were copied into fresh `r3` roots and verified byte-for-byte before restart: shard A's tree is `6a60207df5281efa3f97c85f2bc187ab27b296ce3307a4722aec812b1d959ede`; shard B's is `e246256509f488f09133c28183c911694c16e979e3d01f29692d2a726dd72ffa`. The two `r3` units started together at `2026-07-16T05:36:54Z`. Their identities pin runner SHA-256 `873cf9cc4ebecc4811dc1ffba0b5b9f0456814ee66bc08cf930767bfe438acf9`, OCR-script SHA-256 `04fce55829896a4ecd829d28dcc9c18c2c400a3ba7face2d8d0cde07989a154a`, the same disjoint manifest hashes and the same runtime fingerprint `a45041b1bcae6a764698e4cc61b6ae8a33c3ba00135d099ff82c027ed2888a76`. Recovery accepted the copied 480 pages with valid run-status sidecars and resumed both partial documents. This remains non-citable staging; it does not change the Mac ledger or establish OCR correctness by itself.

The r3 acceptance window found a real content-path failure and stopped both shards at `2026-07-16T05:41:06Z` before it could consume a document retry budget. Shard A had advanced from 243 to 259 pages with no failed page. In shard B, one queued recognizer request produced the same llama.cpp PEG-native parser 500 three times; the Paddle queue then marked all physical pages 33–48 as failed even though the service remained healthy and never restarted. An isolated `parallel=1`, 240-DPI rerun proved the actual boundary: pages 33–39 and 41–48 all completed, while physical page 40 alone reproduced the PEG error. The r3 failure markers and logs remain evidence; they were not rewritten as successes.

The queued fast path now falls back to strict single-page prediction whenever a queued call or its complete `input_path` mapping is rejected. It commits none of the rejected batch, revalidates each fallback result against the exact requested path, commits unaffected pages, and records only the genuinely failing page. A shared outage still makes the child nonzero and is caught by the runner's complete post-failure re-attestation. Fresh `r4` roots were copied and byte-verified from r3 before restart; their combined document/cache tree hashes are `70a73415954b4fed3aa8c2346388f811968fc002a498410db089d30680b57bd2` for A and `07fa00db3e2a23f91429e1de3838ac9c433a646b3254dca6c528c3e496acc27d` for B. The r4 identities pin runner SHA-256 `399241840dde169cc3b63eb21725f6a0d1bb3378fd60a85c15f8b39b3543f8ca` and OCR-script SHA-256 `abf9f6456227514a3e764ed20a8180fd6cab62e01ccddd99ed8ff7f86b339819`; both units started at `2026-07-16T05:53:10Z`. Physical pages 40 and 72 remain explicitly fail-closed until a traceable alternate recognition or the Mac image/Vision/online verification chain resolves them.

Byte-level inspection of that page found a deterministic orphan byte token in the PaddleOCR-VL generation. llama.cpp rejects it while applying the PEG-native chat parser, so `/v1/chat/completions` returns 500 before PaddleX can receive content. This matches the upstream [llama.cpp PaddleOCR-VL report](https://github.com/ggml-org/llama.cpp/issues/24327) and related [PaddleOCR report](https://github.com/PaddlePaddle/PaddleOCR/issues/18170). At this checkpoint there is no merged upstream fix or safe parser-only switch: `--skip-chat-parsing` still validates PEG content, while raw completion can serialize an invalid byte as U+FFFD and silently corrupt the transcription. Therefore the production rule is unchanged: keep successful pages, isolate the exact failing page, retain its image and byte/hash evidence, and resolve it with another traceable recognizer plus the Mac image/Vision/same-edition online chain. Replacement characters, parser-bypass output and guessed text are never citation-eligible.

The full 96-page Russian document then completed 94 pages and isolated the same failure class at pages 40 and 72. Its child returned exit 1, the runner re-attested the complete shared runtime, wrote `retry_wait`, and immediately scheduled the next healthy document instead of blocking the shard. At `2026-07-16T06:16:31Z`, shard A held 401 completed staging pages with no failure; shard B held 299 completed staging pages with only those two failed pages. Both status sidecars verified, all four user units were active with zero restart, and total staging had reached 700 pages. This proves failure containment and continuation, not correctness or citation eligibility.

The final provenance audit intentionally stopped r4 at shard A 529 plus shard B 426, or 955 completed pages, with only those two failed pages and zero restart. r5 moves the output-root owner lock ahead of every cache, probe, identity and status operation; completely revalidates runner/OCR/llama/Python/cache identity after any child failure; prevents shared failures from consuming a document attempt; and closes the signal-before-child-registration race. The planner now rejects malformed, null or unsupported state and symlink/protected-path aliases using lexical plus realpath/nearest-existing-parent checks. A batch that already contains a recorded failed page goes directly to strict single-page prediction for that page, while later clean batches retain MB16 throughput.

r4 document/cache state was copied byte-for-byte into r5 with A/B tree SHA-256 `2d4e49f37e26fc1cc98263e61537cdb162c66a70462f88ec9db3f1f8f52fe9bf` and `fd0372647993f67cb0e1d28b4db8145ec7f725b8d1bb9e3bde81d4493854e5e6`. r5 pins runner `8d19a7b0cc1f619b492fb7b94fd7c96a7f5e83098e185479e1de645866ae9565`, OCR script `b4ea873026fb4d2da2efb921ddac3974a48db703143ff53aff3ebeae48d9b048`, planner `4b248524ccabb16ca272e95592b3ac21b968b6ecebccae56874823ab2edca4dd` and runtime fingerprint `a45041b1bcae6a764698e4cc61b6ae8a33c3ba00135d099ff82c027ed2888a76`. Local Node 112/112 and Python 12/12 tests passed; remote targeted Node 38/38, Python 12/12 and systemd verification passed. At `2026-07-16T06:49:37Z`, shard A held 577 completed pages and shard B 453, for 1,030/5,483 total; pages 40 and 72 were the only failures, both sidecars and all 21 state/page mappings verified, and A/B/llama/monitor were active with `NRestarts=0`. This remains non-citable staging.

## Three-layer evidence rule

Every released OCR passage has three possible evidence layers:

1. Scan: immutable PDF checksum, physical PDF page, rendered-page checksum, and visual location.
2. Transcription: Paddle structured output plus Apple Vision; PP-Structure is required for conflicts, tables, names, dates and numerals.
3. Online witness: an official or academic page that establishes document identity, exact edition where possible, and the checked text or stable fact.

The scan remains primary. Online text never silently overwrites a historical scan. The online witness may correct OCR only after its version scope is recorded.

## Version-aware online checks

For a catalog/table item, first identify the containing document from a nearby title page or body heading. Then locate the item in the same scan by title, author, first line or section heading. Only then search official or academic websites.

Each online witness receives one version status:

- `exact_document_exact_edition`: same title, issuing body, year/version and section.
- `exact_document_revision_uncertain`: same named document but revision boundary is not proven.
- `same_work_different_edition`: useful only for explicitly stable facts.
- `stable_fact_only`: authorship, canonical title or another fact not dependent on edition wording.
- `not_matched`: excluded from correction decisions.

Search snippets are discovery aids, never final evidence. A newer standard may confirm that `《窦娥冤》—关汉卿` is a stable authorship fact, but it cannot replace wording in a 2000 teaching outline. The 2000 and 2002 high-school outlines are separate versions and must remain separate records.

## Release gates

### Numeric page thresholds

The first production witness for every page is generated from a fresh 240 DPI PNG. A recovery run may reuse that PNG and Apple Vision sidecar only when the sidecar still matches the document id, physical page, source-PDF SHA-256 and actual rendered-image SHA-256; missing or drifted evidence is rendered and recognized again. A 300 DPI render is reserved for PP-Structure or human adjudication of disputed regions: the larger 8.41-megapixel page repeatedly destabilized Apple Vision, while the 240 DPI 5.38-megapixel page passed the bounded production canaries. Apple Vision receives no Paddle text, correction list or Paddle-derived dictionary. After NFKC and removal of layout markup, an automatic page pass requires all of the following:

- normalized character agreement at least 99.5%;
- Apple Vision mean line confidence at least 0.80;
- title, document year/version, personal names, dates and all numerals agree exactly;
- a table preserves row/column pairing and cell order, not merely the same bag of words;
- the scan shows no cropped, obscured or unreadable region.

The comparison script cannot infer historical personal names reliably from character agreement alone. Automatic release therefore also requires the Apple Vision sidecar to declare every high-risk token in `critical_fields` with independently entered primary/witness readings. Missing declarations are fail-closed. Pages containing HTML table markup never pass automatically; they always enter cell-by-cell image adjudication.

Agreement from 98.5% to 99.5% may only enter manual image review. Every differing character is resolved against the scan and retained in a decision ledger. Below 98.5%, or whenever a title/version/table cannot be aligned, the page is `unresolved_fail_closed`. Empty output from both engines is only a blank-page candidate until a human checks the rendered page. No sampled page promotes an entire document.

`verified_exact` requires all of the following:

- source and rendered-page checksums exist;
- physical PDF page and printed page, when present, are recorded separately;
- structured OCR and at least one independent OCR witness agree on names, dates, numerals and quotation text;
- the document identity and edition boundary are supported by official or academic evidence;
- all title/author catalog rows preserve pairing and order;
- a human checks every high-risk exact quotation and every resolved conflict.

If exact closure is impossible but the scan is legible, the text may be visible as `human_judgment_with_warning`. It must show the uncertainty note and remain unavailable to citation-locked AI. `unresolved_fail_closed` is metadata-only.

Never:

- replace older wording with a newer edition;
- “correct” historical spelling through an LLM rewrite;
- promote an entire document because sampled pages passed;
- discard a minority OCR reading before looking at the image;
- expose an unresolved page as an unqualified exact quotation.

The machine-readable policy is `data/online-verification-standard.json`; database support is in `migrations/0003_online_verification.sql`.

### Remote whole-document import gate

Remote output never enters the local OCR ledger page by page. `scripts/plan-remote-ocr-offload.mjs` selected and revalidated 72 wholly untouched documents, 5,483 pages and 2,017,324,713 source bytes; 14 documents with local completion, retry or state conflicts were excluded. The parent manifest SHA-256 remains `3050f22e7bda3cb5aafb1817bc861b7f7b8d65e358dbbba3b5a0b35af4b27c8f`. It was split by exact document identity into two disjoint manifests: shard `a` has 36 documents / 2,771 pages / 1,072,093,739 bytes and SHA-256 `a532240cf6d9deeec2843997156afa38fa2518f24d976d625769cec3765fcc9b`; shard `b` has 36 documents / 2,712 pages / 945,230,974 bytes and SHA-256 `744a50b84920dbed0d62d41318af71ca90a420f073c4322d04e501948eee075c`. Their checked union is exactly the unchanged parent set. A remote document is importable only when all of the following remain true:

- the local document still has zero completed pages at import time;
- source PDF SHA-256, byte size and physical page count equal the planned manifest;
- the remote page set contains every integer from 1 through `page_count` exactly once;
- each page's `result.json` and `content.md` can be rehashed and match its state; the remote `rendered_image_sha256` is only the recorded hash of the temporary recognition render and is not treated as independently revalidated image evidence;
- the run identity pins the manifest, OCR script, model, multimodal projector, llama.cpp commit, runtime device and worker configuration;
- the document and every page remain `citation_allowed=false` / `citation_eligible=false`;
- no document is accepted if any source, identity, configuration, page-set or artifact gate fails.

Even a fully accepted remote document supplies only staged primary OCR. The Mac must render a fresh evidence image from the source PDF at 240 DPI, record and retain its hash, run blind Apple Vision, complete the exact-page image/OCR comparison and apply the version-aware official/academic online check before any passage can be published or cited.

## Queue coverage gate

OCR 速度不能掩盖漏排。`scripts/audit-local-moe-scans.mjs` 在每次重建队列前审计本机缓存的教育部 2011/2022 义务教育课程标准：核对 PDF 签名、物理页数、SHA-256 和是否存在可用原生正文，并将结果固定到 `data/local-official-scans.json`。覆盖测试要求所有合格扫描件都进入 `data/ocr-queue.json`，且不得因为文件名、目录来源或已有目录记录而静默遗漏。

2026-07-15 审计新增 36 份教育部扫描件、3,157 页；总队列由 50 份/8,690 页扩大为 86 份/11,847 页。36 份均为 `text_quality_status=ocr_required`、`citation_allowed=false`。2011 年版语文 83 页和 2022 年版语文 109 页优先级为 0，以便尽快为普通义务教育语文本体补齐版次证据；优先识别不改变任何质量门。

生产队列只在完整批次边界切换。watchdog 先进入 hold，核对精确 drain PID、cwd、命令、锁归属和已完成批次，再向该 owner 发送终止信号；确认锁释放后恢复 run。不得在 PaddleOCR 页处理中为加载新队列强行中断，也不得删除已通过 source/image/result hash 与 exact audit 的页面。

## Reproducible commands

Generate the queue:

```bash
node scripts/audit-local-moe-scans.mjs
node scripts/prepare-ocr-queue.mjs
```

Run a resumable document OCR job after starting the pinned local llama.cpp server:

```bash
PADDLE_PDX_CACHE_HOME=.cache/paddlex \
  .cache/venv-paddleocr/bin/python scripts/ocr-pdf-paddle.py \
  <DOCUMENT_ID> <INPUT_PDF> .cache/ocr-production
```

Run only selected pages during adjudication:

```bash
PADDLE_PDX_CACHE_HOME=.cache/paddlex \
  .cache/venv-paddleocr/bin/python scripts/ocr-pdf-paddle.py \
  <DOCUMENT_ID> <INPUT_PDF> .cache/ocr-production --pages 1,20-24,567 --save-visuals
```

Re-run the benchmark:

```bash
PADDLE_PDX_CACHE_HOME=.cache/paddlex \
  .cache/venv-paddleocr/bin/python scripts/benchmark-ocr-stack.py
node scripts/audit-ocr-benchmark.mjs \
  paddleocr-vl=.cache/ocr-benchmark/paddleocr-vl-1.6 \
  pp-structure=.cache/ocr-benchmark/pp-structure-v3 \
  apple-vision=.cache/ocr-benchmark/apple-vision
```

Generate the fail-closed remote whole-document manifest and inspect the runner contract:

```bash
node scripts/plan-remote-ocr-offload.mjs --output <OFFLOAD_MANIFEST>
node scripts/run-remote-ocr-offload.mjs --help
```

并发/吞吐实验必须用 `--output-report data/ocr-throughput-benchmark-results.json` 或 `.cache/` 下的临时路径，不能覆盖跨引擎质量基准 `data/ocr-benchmark-results.json`。Mac Metal profile 采用已复核的 `OCR_LLAMA_PARALLEL=3` 与 `OCR_VL_REC_MAX_CONCURRENCY=3`；llama 总 context 为 `3 × 8,192`，不是把单槽 context 降低到三分之一。Kali staging profile 使用独立 output root、`parallel=4` 与显式 `micro_batch=16 --use-queues`，不得把两种 profile 的吞吐或状态混记。

All page jobs are resumable and refuse to mix results if the PDF checksum changes. OCR completion alone never sets `citation_eligible` to true.

## Supervisor fault tolerance and health contract

Use the supervisor instead of invoking a long unbounded document job:

```bash
npm run ocr:check
npm run ocr:once -- --batch-pages 32
npm run ocr:drain -- --batch-pages 64
npm run ocr:recover
```

`ocr:check` is machine-readable and exits with `0` healthy, `2` retry/backoff pending, `10` unresolved run/page/witness failure, `11` stalled lock, `12` checksum/disk/quarantine hard stop, or `75` an actively owned run. A healthy code means the OCR runtime is internally consistent; it does not mean every audited page is citation-ready.

`ocr:drain` is the production fast path. One drain owner serially starts bounded batches and, while the queue remains healthy, begins the next batch after one second instead of waiting for another automation handoff. A separate drain lock prevents two drain processes from alternating ownership in the per-batch lock gap. Every batch rechecks queue health, scheduler state and disk; below 50 GiB it stops before another batch, below 25 GiB remains a global hard stop, and a stale active owner stops with exit `11`. Queue completion is recorded only when health is `0`, scheduler state is `queue_complete`, failures/errors/missing/stale evidence are all zero, and primary OCR, valid Vision witnesses and audits have exact page-count parity.

The visible Codex automation is paused. The local LaunchAgent `com.suen.curriculum-ocr-watchdog` normally owns silent continuity and polls the exact drain/batch owner every 15 seconds. It validates PID, command, working directory, lock identity and current heartbeat; it signals only the same drain after two consecutive observations beyond 180 seconds, then re-evaluates health and permits at most a one-page recovery canary. Unknown processes are never killed. The watchdog continues polling while a drain child it spawned is running; `starting_drain` must not remain the last state for the life of the queue. A standalone `ocr:status` resolves the effective parallelism from the active run/drain policy, or from the verified watchdog owner and control for a legacy live run, so the shell's default environment cannot misreport a 3-way run as 1-way. During the Kali offload the local watchdog control is deliberately `hold`, with no local drain or Paddle owner, so a document cannot become locally nonempty behind the whole-document import gate.

Production witness rendering uses the pinned MuPDF 1.28.0 binary, not Poppler. The change was introduced after macOS `syspolicyd` exhausted its file-descriptor allowance (`UNIX error 24`) and new Homebrew executables stalled in dyld `fcntl`; repeated `pdftoppm` processes therefore stopped before opening the PDF. MuPDF preserves the accepted 240 DPI PNG contract while bypassing that Poppler launch path. Primary-runtime validation checks the exact renderer SHA-256 together with the model and multimodal projector hashes; a mismatch is a global fail-closed error.

Every local-Mac `runCapture` helper child has task ownership, a bounded timeout and optional 30-second run heartbeat. The MuPDF page render ceiling is 30 seconds; a timeout records `CAPTURE_TIMEOUT`, terminates only that child and releases the recorded owner instead of leaving the watchdog on a dead render. Local-Mac Paddle is judged separately: its startup ceiling is 180 seconds, its no-progress ceiling is 300 seconds, and its batch wall-time ceiling is the greater of 20 minutes or 25 seconds per scheduled page. Progress is accepted only from the task log or `state.json`; on expiry the local supervisor signals that exact child with `SIGTERM`, waits five seconds, then uses `SIGKILL` only if the same child still exists. A watchdog child is also cleared through a scope-safe finalizer, so an exited recovery or drain cannot crash the LaunchAgent loop. These controls bound failure; they do not turn an incomplete page into success. The isolated Kali offload uses its separately documented 15-second TERM grace.

Apple Vision has its own batch and single-page startup/idle/wall ceilings. A batch process failure is converted into per-page retries; one retry crash cannot stop later pages. Before any invalid witness is rerun, the old JSON/TXT pair is removed. A replacement sidecar is accepted only when its mtime belongs to the current attempt and its filename, document, physical page, PDF SHA and rendered-image SHA match; the image SHA is recomputed again after Vision returns. This prevents a stale sidecar from being rebound to a newly rendered page after a Swift timeout or crash. If watchdog bookkeeping fails after spawning a supervisor, it tears down only that task-owned child with `SIGTERM`, a five-second wait and then `SIGKILL`, rather than leaving an unobserved drain.

A Paddle child that is killed, times out, or reports a native-library launch failure is a runtime incident, not a page-content failure. System-policy `dlopen` denial, `EMFILE`/`ENFILE`, and the secondary `libpaddle` import failure are recorded as `PADDLE_RUNTIME_UNAVAILABLE`, receive a five-minute runtime backoff, and do not increment any page-stage retry or quarantine counter. `reconcile-runtime-retries` is dry-run by default and may remove an old generic page retry only when the retained run history and its Paddle log prove the failure came from the runtime; `--apply` refuses to run with a live batch owner and first writes an exact backup of the retry ledger.

A page-stage quarantine is local. When the only nonzero health reason is `PAGE_QUARANTINED`, another batch is available and the scheduler is `ready`, the drain skips the quarantined page and continues other eligible work. Document quarantine, checksum/runtime drift, witness errors, disk limits, unknown ownership and any mixed failure reason still stop the drain. Five failed attempts leave the page unavailable to citation and do not erase its valid independent witness.

The remote runner has a separate document-level recovery contract. It retains valid completed page artifacts but does not accept an incomplete document, permits at most five attempts with 2/10/30/60-second backoff, and writes `retry_wait` rather than hammering a failed document. Exhausted or contradictory state becomes terminal `quarantined` with exit `12`; interrupted work exits `75`; permanent startup or configuration faults exit `2`. Every user systemd offload instance must use `RestartPreventExitStatus=2 12 75` plus bounded start limits, and the llama unit must be the exact active owner of the loopback server passed through `--llama-systemd-unit`. Final success requires every document entry in each shard's `run-status.json` to be `complete` with no pending, running, retry-wait or quarantined entries, followed by whole-document page-set and hash verification.

The first remote production-start attempt, retained as `r1`, exposed a venv-realpath startup defect and shared-probe misclassification: the resolved interpreter target was invoked instead of the lexical virtual-environment entrypoint, and the shared failure was written as 72 document quarantine status rows with `attempts=0`. It produced zero pages and zero artifacts. The runner now records both invocation and resolved paths while executing the lexical venv path, and a shared probe failure exits `2` before any document mutation. The `r1` identity, status and logs remain incident evidence.

The corrected single-worker `r2` established the 39-page / 231.720-second baseline and then started a second document. It was intentionally stopped for the verified concurrency change with counts `complete=1`, `interrupted=1`, `pending=70`, `quarantined=0`; 16 valid partial pages of the interrupted second document were retained. The old singleton `curriculum-ocr-offload` unit is disabled rather than reused.

The active production staging topology remains the exact-disjoint pair `curriculum-ocr-offload@a` and `curriculum-ocr-offload@b`, sharing the loopback `curriculum-ocr-llama` owner and bounded `curriculum-ocr-gpu-monitor`. The first pair started at `2026-07-16T04:35:27Z`; after the preserved r1-r4 audits, the current r5 pair started at `2026-07-16T06:40:01Z` with the identities recorded above. This is an active staging run, not a corpus-completion or import claim.

The reviewed local Mac production profile uses llama `--parallel 3`, 8,192 context tokens per slot and Paddle `vl_rec_max_concurrency=3`. On the same five manually anchored pages it retained 68/70 anchor recall and parallel-3 output was byte-identical to parallel-1, while elapsed time fell from 45.982 to 35.061 seconds. Two subsequent 64-page batches completed 128/128 primary OCR, Vision witnesses and exact audits with zero failures in 1,630.756 seconds end to end, including the 2.586-second handoff. The 64-page ceiling changes only the scheduling window; it does not relax 240-dpi rendering, either OCR engine, source/image/result hashes, per-page audit, online-version boundaries or citation gates.

The 64-page acceptance canary `2026-07-15T11-18-42-775Z-1a206bf2` processed `legacy-compendium-plans` physical pages 1–64 in 1,238.156 seconds. Primary OCR, valid Vision JSON/TXT witnesses and page audits were all 64/64; page failures, retries, quarantine, error sidecars, missing artifacts, hash mismatches and stale audits were all zero. Its gates remained fail-closed: 35 manual image reviews, 28 unresolved pages, one blank-page confirmation and zero automatic citation passes. The singleton drain acquired the next 64-page batch about 0.8 seconds after the canary completed.

Apple Vision first receives the whole bounded batch. A failed page is then retried in a fresh Swift process after 2, 10 and 30 seconds, without rerendering or exposing Paddle text to the witness. Exhausted failures are recorded by `document + physical page + stage`; another page remains schedulable, and a single transient failure cannot quarantine the whole document. Five exhausted page-level attempts quarantine only that page-stage pair. `ocr:recover` runs one page as a bounded canary.

The 2026-07-16 renderer recovery canary generated and validated Apple Vision witnesses for all 64 Chinese-compendium physical pages 32–95 with MuPDF at 240 DPI. The strict witness count rose from 1,465 to 1,529 with zero error sidecars and zero completed pages missing a witness. This proves the replacement render and Apple Vision stages, not primary OCR completion: the Homebrew Python child subsequently remained in `_dyld_start` during the same `syspolicyd` file-descriptor incident, so those pages stayed incomplete and entered bounded Paddle retry/backoff. Runtime reporting must keep these stages separate.

Paddle's state is reread even when its process reports partial failure. Completed page artifacts are retained and audited; failed pages receive independent retry records. Audits run one physical page at a time, so a missing page cannot discard other successful pages. Signals do not count as OCR failures, task-owned children and llama-server are stopped, and the lock is released only by its recorded owner.

Every Vision sidecar must match its filename, document id, physical page, source-PDF SHA-256 and rendered-image SHA-256. Old or mismatched sidecars are treated as missing evidence and regenerated. Candidate concept graphs are built in a run-specific directory, validated against a matching build revision, and only then atomically promoted to the local last-good candidate. At most two candidate run directories are retained. None of these steps changes the published graph or citation status.

Missing or stale exact-page audits are a separate `audit_backfill` mode. It selects only completed pages whose primary `content.md` / `result.json` and Vision sidecar still pass their recorded identity and SHA checks, then reruns only the comparison ledger; rendering, Apple Vision and PaddleOCR are hard-disabled for that mode. If either input drifts between scheduling and execution, only that page receives an audit-stage retry and no old audit is accepted as current.

Run the independent witness comparison for a bounded page range:

```bash
node scripts/audit-ocr-witnesses.mjs \
  .cache/ocr-production/<DOCUMENT_ID>/pages \
  <APPLE_VISION_OUTPUT_DIR> \
  .cache/ocr-production/<DOCUMENT_ID>/audit-<START>-<END>.json \
  <START> <END>
```

The Chinese-compendium pages are now also retained as page-level audits under `.cache/ocr-witness/legacy-compendium-chinese/audits/`; reviewed high-risk pages 17–20 are represented by `data/ocr-review-legacy-chinese-0017-0020.json`.
