#!/usr/bin/env python3
import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import shutil
import tempfile
import time
import uuid
from pathlib import Path

import paddle
import pypdfium2 as pdfium
from paddleocr import PaddleOCRVL


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def page_selection(value: str | None, page_count: int) -> list[int]:
    if not value:
        return list(range(1, page_count + 1))
    selected = set()
    for part in value.split(","):
        if "-" in part:
            start, end = (int(item) for item in part.split("-", 1))
            selected.update(range(start, end + 1))
        else:
            selected.add(int(part))
    invalid = sorted(page for page in selected if page < 1 or page > page_count)
    if invalid:
        raise ValueError(f"Pages outside 1..{page_count}: {invalid}")
    return sorted(selected)


def main() -> None:
    parser = argparse.ArgumentParser(description="Resumable, page-evidenced PaddleOCR-VL PDF OCR.")
    parser.add_argument("document_id")
    parser.add_argument("input_pdf")
    parser.add_argument("output_root")
    parser.add_argument("--llama-url", default="http://127.0.0.1:8112/v1")
    parser.add_argument("--pages", help="One-based comma/range selection, for example 1,4-7.")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--dpi", type=int, default=240)
    parser.add_argument("--save-visuals", action="store_true")
    parser.add_argument("--force-reprocess", action="store_true", help="Rebuild selected pages even when state marks them complete.")
    parser.add_argument("--vl-rec-max-concurrency", type=int, default=1)
    parser.add_argument("--server-parallel", type=int, default=1)
    args = parser.parse_args()

    input_pdf = Path(args.input_pdf).resolve()
    if not input_pdf.is_file():
        raise FileNotFoundError(input_pdf)
    output_dir = Path(args.output_root).resolve() / args.document_id
    pages_dir = output_dir / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)
    state_path = output_dir / "state.json"
    source_sha256 = sha256(input_pdf)

    document = pdfium.PdfDocument(str(input_pdf))
    page_count = len(document)
    selected = page_selection(args.pages, page_count)
    if args.limit is not None:
        selected = selected[: max(0, args.limit)]

    if state_path.is_file():
        state = json.loads(state_path.read_text(encoding="utf-8"))
        if state.get("source_sha256") != source_sha256:
            raise RuntimeError("Source checksum changed; refusing to mix OCR runs.")
        state.setdefault("configuration", {})["vl_rec_max_concurrency"] = args.vl_rec_max_concurrency
        state["configuration"]["server_parallel"] = args.server_parallel
        atomic_json(state_path, state)
    else:
        state = {
            "schema_version": 1,
            "document_id": args.document_id,
            "source_path": str(input_pdf),
            "source_sha256": source_sha256,
            "page_count": page_count,
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "configuration": {
                "pipeline": "PaddleOCR-VL",
                "pipeline_version": "v1.6",
                "layout_model": "PP-DocLayoutV3",
                "recognizer": "PaddleOCR-VL-1.6-0.9B official GGUF",
                "recognizer_backend": "llama-cpp-server",
                "recognizer_server_url": args.llama_url,
                "dpi": args.dpi,
                "device": "cpu+Metal llama.cpp",
                "python": platform.python_version(),
                "paddlepaddle": paddle.__version__,
                "paddleocr": importlib.metadata.version("paddleocr"),
                "paddlex": importlib.metadata.version("paddlex"),
                "vl_rec_max_concurrency": args.vl_rec_max_concurrency,
                "server_parallel": args.server_parallel,
            },
            "completed_pages": [],
            "failed_pages": {},
            "pages": {},
        }
        atomic_json(state_path, state)

    pipeline = PaddleOCRVL(
        pipeline_version="v1.6",
        vl_rec_backend="llama-cpp-server",
        vl_rec_server_url=args.llama_url,
        vl_rec_max_concurrency=max(1, args.vl_rec_max_concurrency),
        device="cpu",
    )

    with tempfile.TemporaryDirectory(prefix=f"curriculum-paddle-{args.document_id}-") as temporary:
        temporary_dir = Path(temporary)
        for page_number in selected:
            page_key = str(page_number)
            page_dir = pages_dir / f"{page_number:04d}"
            if not args.force_reprocess and page_number in state["completed_pages"] and (page_dir / "content.md").is_file() and (page_dir / "result.json").is_file():
                print(f"skip {args.document_id} page {page_number}/{page_count}", flush=True)
                continue
            if args.force_reprocess:
                state["completed_pages"] = [page for page in state["completed_pages"] if page != page_number]
                state["pages"].pop(page_key, None)
                atomic_json(state_path, state)
            staging_dir = pages_dir / f".{page_number:04d}-staging-{uuid.uuid4().hex}"
            backup_dir = pages_dir / f".{page_number:04d}-backup-{uuid.uuid4().hex}"
            staging_dir.mkdir(parents=True, exist_ok=False)
            image_path = temporary_dir / f"page-{page_number:04d}.png"
            started = time.monotonic()
            try:
                page = document[page_number - 1]
                bitmap = page.render(scale=args.dpi / 72)
                bitmap.to_pil().save(image_path)
                image_sha256 = sha256(image_path)
                results = list(pipeline.predict(str(image_path)))
                if len(results) != 1:
                    raise RuntimeError(f"Expected one page result, received {len(results)}")
                result = results[0]
                result.save_to_json(save_path=str(staging_dir / "result.json"))
                markdown_temp = staging_dir / "markdown"
                result.save_to_markdown(save_path=str(markdown_temp))
                markdown_files = sorted(markdown_temp.glob("*.md"))
                if len(markdown_files) != 1:
                    raise RuntimeError(f"Expected one Markdown result, received {len(markdown_files)}")
                shutil.copy2(markdown_files[0], staging_dir / "content.md")
                if args.save_visuals:
                    result.save_to_img(save_path=str(staging_dir / "visual"))
                elapsed = round(time.monotonic() - started, 3)
                if page_dir.exists():
                    page_dir.replace(backup_dir)
                try:
                    staging_dir.replace(page_dir)
                except Exception:
                    if backup_dir.exists() and not page_dir.exists():
                        backup_dir.replace(page_dir)
                    raise
                if backup_dir.exists():
                    shutil.rmtree(backup_dir)
                state["pages"][page_key] = {
                    "status": "ocr_complete_pending_audit",
                    "physical_pdf_page": page_number,
                    "rendered_image_sha256": image_sha256,
                    "elapsed_seconds": elapsed,
                    "result_json_sha256": sha256(page_dir / "result.json"),
                    "content_markdown_sha256": sha256(page_dir / "content.md"),
                    "citation_eligible": False,
                }
                state["completed_pages"] = sorted(set(state["completed_pages"] + [page_number]))
                state["failed_pages"].pop(page_key, None)
                state["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                atomic_json(state_path, state)
                print(f"done {args.document_id} page {page_number}/{page_count} {elapsed}s", flush=True)
            except Exception as error:
                if staging_dir.exists():
                    shutil.rmtree(staging_dir)
                state["failed_pages"][page_key] = {
                    "error": f"{type(error).__name__}: {error}",
                    "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
                state["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                atomic_json(state_path, state)
                print(f"failed {args.document_id} page {page_number}/{page_count}: {error}", flush=True)
            finally:
                image_path.unlink(missing_ok=True)

    state["finished_selected_pages_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    state["selected_pages"] = selected
    state["selected_pages_complete"] = all(page in state["completed_pages"] for page in selected)
    atomic_json(state_path, state)
    if not state["selected_pages_complete"]:
        raise SystemExit(1)


if __name__ == "__main__":
    os.environ.setdefault("PADDLE_PDX_CACHE_HOME", ".cache/paddlex")
    main()
