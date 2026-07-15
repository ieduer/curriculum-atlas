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

Apple Vision is rerun on every page in the adjudication range from a fresh 300 DPI PNG. It receives no Paddle text, correction list or Paddle-derived dictionary. After NFKC and removal of layout markup, an automatic page pass requires all of the following:

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

## Reproducible commands

Generate the queue:

```bash
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

All page jobs are resumable and refuse to mix results if the PDF checksum changes. OCR completion alone never sets `citation_eligible` to true.

Run the independent witness comparison for a bounded page range:

```bash
node scripts/audit-ocr-witnesses.mjs \
  .cache/ocr-production/<DOCUMENT_ID>/pages \
  <APPLE_VISION_OUTPUT_DIR> \
  .cache/ocr-production/<DOCUMENT_ID>/audit-<START>-<END>.json \
  <START> <END>
```

The current Chinese-compendium 10–20 result is retained locally as `.cache/ocr-production/legacy-compendium-chinese/audit-0010-0020.json`; reviewed high-risk pages 17–20 are represented by `data/ocr-review-legacy-chinese-0017-0020.json`.
