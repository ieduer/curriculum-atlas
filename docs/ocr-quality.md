# OCR quality and version-aware online verification

## Decision

The production primary is the official PaddleOCR-VL 1.6 document pipeline: PP-DocLayoutV3 detects regions and reading order, then the official PaddleOCR-VL-1.6 model recognizes each region through a local llama.cpp Metal server. Apple Vision `accurate` OCR is the fast independent witness. PP-StructureV3 with PP-OCRv5 is the adjudication engine for disputed characters and coordinates. Tesseract is retained only as a diagnostic baseline because it did not meet the benchmark threshold.

Official technical references:

- [PaddleOCR documentation](https://www.paddleocr.ai/latest/en/index.html)
- [PaddleOCR-VL pipeline](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/PaddleOCR-VL.html)
- [PaddleOCR-VL on Apple Silicon](https://www.paddleocr.ai/main/en/version3.x/pipeline_usage/PaddleOCR-VL-Apple-Silicon.html)
- [PP-StructureV3](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/PP-StructureV3.html)
- [PaddleOCR source](https://github.com/PaddlePaddle/PaddleOCR)
- [PaddleOCR-VL-1.6 model](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6)
- [Official GGUF model](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF)
- [OmniDocBench](https://github.com/opendatalab/OmniDocBench)

Pinned runtime:

- project-local Python 3.13 environment: `.cache/venv-paddleocr`
- PaddlePaddle 3.3.1
- PaddleOCR 3.7.0
- PaddleX 3.7.2
- llama.cpp commit `12127defda4f41b7679cb2477a4b0d65ee6a0c8f`
- GGUF SHA-256 `f3ae46ec885050acf4b3d31944431e1fd90d50664fb09126af4a3c050ba14ee8`
- multimodal projector SHA-256 `204d757d7610d9b3faab10d506d69e5b244e32bf765e2bab2d0167e65e0a058a`
- model repository revision `511b09642bb324401f15f97cc23bc67e8f0a291d`

The Apple Silicon-specific PaddleOCR guide was followed: native Paddle installation, not the unsupported Docker path. MLX-VLM is not the production stack because it serves only the VLM stage and does not replace layout detection/read-order reconstruction.

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

Apple Vision is rerun on every production page from a fresh 240 DPI PNG. A 300 DPI render is reserved for PP-Structure or human adjudication of disputed regions: the larger 8.41-megapixel page repeatedly destabilized Apple Vision, while the 240 DPI 5.38-megapixel page passed the bounded production canaries. Apple Vision receives no Paddle text, correction list or Paddle-derived dictionary. After NFKC and removal of layout markup, an automatic page pass requires all of the following:

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

并发/吞吐实验必须用 `--output-report data/ocr-throughput-benchmark-results.json` 或 `.cache/` 下的临时路径，不能覆盖跨引擎质量基准 `data/ocr-benchmark-results.json`。生产采用已复核的 `OCR_LLAMA_PARALLEL=3` 与 `OCR_VL_REC_MAX_CONCURRENCY=3`；llama 总 context 为 `3 × 8,192`，不是把单槽 context 降低到三分之一。

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

The visible Codex automation is paused. The local LaunchAgent `com.suen.curriculum-ocr-watchdog` owns silent continuity and polls the exact drain/batch owner every 15 seconds. It validates PID, command, working directory, lock identity and current heartbeat; it signals only the same drain after two consecutive observations beyond 180 seconds, then re-evaluates health and permits at most a one-page recovery canary. Unknown processes are never killed. The watchdog continues polling while a drain child it spawned is running; `starting_drain` must not remain the last state for the life of the queue. A standalone `ocr:status` resolves the effective parallelism from the active run/drain policy, or from the verified watchdog owner and control for a legacy live run, so the shell's default environment cannot misreport a 3-way run as 1-way.

The reviewed production profile uses llama `--parallel 3`, 8,192 context tokens per slot and Paddle `vl_rec_max_concurrency=3`. On the same five manually anchored pages it retained 68/70 anchor recall and parallel-3 output was byte-identical to parallel-1, while elapsed time fell from 45.982 to 35.061 seconds. Two subsequent 64-page batches completed 128/128 primary OCR, Vision witnesses and exact audits with zero failures in 1,630.756 seconds end to end, including the 2.586-second handoff. The 64-page ceiling changes only the scheduling window; it does not relax 240-dpi rendering, either OCR engine, source/image/result hashes, per-page audit, online-version boundaries or citation gates.

The 64-page acceptance canary `2026-07-15T11-18-42-775Z-1a206bf2` processed `legacy-compendium-plans` physical pages 1–64 in 1,238.156 seconds. Primary OCR, valid Vision JSON/TXT witnesses and page audits were all 64/64; page failures, retries, quarantine, error sidecars, missing artifacts, hash mismatches and stale audits were all zero. Its gates remained fail-closed: 35 manual image reviews, 28 unresolved pages, one blank-page confirmation and zero automatic citation passes. The singleton drain acquired the next 64-page batch about 0.8 seconds after the canary completed.

Apple Vision first receives the whole bounded batch. A failed page is then retried in a fresh Swift process after 2, 10 and 30 seconds, without rerendering or exposing Paddle text to the witness. Exhausted failures are recorded by `document + physical page + stage`; another page remains schedulable, and a single transient failure cannot quarantine the whole document. Five exhausted page-level attempts quarantine only that page-stage pair. `ocr:recover` runs one page as a bounded canary.

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
