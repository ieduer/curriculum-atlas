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


DEFAULT_RUNTIME_DEVICE = "cpu+Metal llama.cpp"


class QueuedResultContractError(ValueError):
    pass


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


def page_chunks(page_numbers: list[int], size: int) -> list[list[int]]:
    if size < 1 or size > 16:
        raise ValueError("Micro-batch size must be between 1 and 16.")
    return [page_numbers[index : index + size] for index in range(0, len(page_numbers), size)]


def effective_micro_batch(value: int, use_queues: bool) -> int:
    if value < 1 or value > 16:
        raise ValueError("--micro-batch must be between 1 and 16.")
    if value != 1 and not use_queues:
        raise ValueError("--micro-batch greater than 1 requires --use-queues.")
    return value if use_queues else 1


def validated_runtime_device(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError("--runtime-device must be a non-empty provenance label.")
    return normalized


def ensure_runtime_device(configuration: dict, runtime_device: str) -> None:
    existing = configuration.get("device")
    if existing is None:
        configuration["device"] = runtime_device
        return
    if existing != runtime_device:
        raise RuntimeError(
            f"Runtime device changed from {existing!r} to {runtime_device!r}; refusing to mix OCR runs."
        )


def normalized_input_path(value: str | os.PathLike[str]) -> str:
    return str(Path(value).resolve())


def expected_page_inputs(page_images: dict[int, Path]) -> dict[str, int]:
    indexed: dict[str, int] = {}
    for page_number, image_path in page_images.items():
        normalized = normalized_input_path(image_path)
        if normalized in indexed:
            raise ValueError(f"Duplicate expected input_path: {normalized}")
        indexed[normalized] = page_number
    return indexed


def result_page_number(result, expected_inputs: dict[str, int], returned_inputs: set[str]) -> tuple[int, str]:
    try:
        raw_input_path = result["input_path"]
    except (KeyError, TypeError) as error:
        raise ValueError("Paddle result is missing input_path.") from error
    if not raw_input_path:
        raise ValueError("Paddle result has an empty input_path.")
    normalized = normalized_input_path(raw_input_path)
    if normalized not in expected_inputs:
        raise ValueError(f"Unexpected Paddle result input_path: {normalized}")
    if normalized in returned_inputs:
        raise ValueError(f"Duplicate Paddle result input_path: {normalized}")
    return expected_inputs[normalized], normalized


def missing_result_pages(expected_inputs: dict[str, int], returned_inputs: set[str]) -> list[int]:
    return [page_number for normalized, page_number in expected_inputs.items() if normalized not in returned_inputs]


def validated_queued_results(results, expected_inputs: dict[str, int]) -> tuple[list[tuple[int, object]], set[str]]:
    mapped_results: list[tuple[int, object]] = []
    returned_inputs: set[str] = set()
    for result in results:
        try:
            page_number, normalized = result_page_number(result, expected_inputs, returned_inputs)
        except Exception as error:
            raise QueuedResultContractError(str(error)) from error
        returned_inputs.add(normalized)
        mapped_results.append((page_number, result))
    missing = missing_result_pages(expected_inputs, returned_inputs)
    if missing:
        raise QueuedResultContractError(f"Paddle queued batch is missing results for pages: {missing}")
    return mapped_results, returned_inputs


def predict_pages_individually(pipeline, page_images: dict[int, Path]) -> tuple[dict[int, object], dict[int, Exception]]:
    successful: dict[int, object] = {}
    failed: dict[int, Exception] = {}
    for page_number in sorted(page_images):
        image_path = page_images[page_number]
        expected_inputs = expected_page_inputs({page_number: image_path})
        try:
            mapped_results, _ = validated_queued_results(
                pipeline.predict(str(image_path)),
                expected_inputs,
            )
            successful[page_number] = mapped_results[0][1]
        except Exception as error:
            failed[page_number] = error
    return successful, failed


def main() -> None:
    import paddle
    import pypdfium2 as pdfium
    from paddleocr import PaddleOCRVL

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
    parser.add_argument("--micro-batch", type=int, default=1, help="Pages per queued Paddle call (1-16; requires --use-queues above 1).")
    parser.add_argument("--use-queues", action="store_true", help="Explicitly enable queued list prediction with temperature=0.")
    parser.add_argument("--runtime-device", default=DEFAULT_RUNTIME_DEVICE, help="Immutable runtime provenance label stored in state.json.")
    args = parser.parse_args()
    try:
        micro_batch = effective_micro_batch(args.micro_batch, args.use_queues)
        runtime_device = validated_runtime_device(args.runtime_device)
    except ValueError as error:
        parser.error(str(error))

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
        state.setdefault("failed_pages", {})
        configuration = state.setdefault("configuration", {})
        ensure_runtime_device(configuration, runtime_device)
        configuration["vl_rec_max_concurrency"] = args.vl_rec_max_concurrency
        configuration["server_parallel"] = args.server_parallel
        configuration["micro_batch"] = micro_batch
        configuration["use_queues"] = args.use_queues
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
                "device": runtime_device,
                "python": platform.python_version(),
                "paddlepaddle": paddle.__version__,
                "paddleocr": importlib.metadata.version("paddleocr"),
                "paddlex": importlib.metadata.version("paddlex"),
                "vl_rec_max_concurrency": args.vl_rec_max_concurrency,
                "server_parallel": args.server_parallel,
                "micro_batch": micro_batch,
                "use_queues": args.use_queues,
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
        def record_failure(page_number: int, error: Exception) -> None:
            page_key = str(page_number)
            state["completed_pages"] = [page for page in state["completed_pages"] if page != page_number]
            state["pages"].pop(page_key, None)
            state["failed_pages"][page_key] = {
                "error": f"{type(error).__name__}: {error}",
                "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            state["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            atomic_json(state_path, state)
            print(f"failed {args.document_id} page {page_number}/{page_count}: {error}", flush=True)

        def commit_result(page_number: int, result, image_sha256: str, started: float) -> None:
            page_key = str(page_number)
            page_dir = pages_dir / f"{page_number:04d}"
            staging_dir = pages_dir / f".{page_number:04d}-staging-{uuid.uuid4().hex}"
            backup_dir = pages_dir / f".{page_number:04d}-backup-{uuid.uuid4().hex}"
            staging_dir.mkdir(parents=True, exist_ok=False)
            try:
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
                result_json_sha256 = sha256(staging_dir / "result.json")
                content_markdown_sha256 = sha256(staging_dir / "content.md")
                if page_dir.exists():
                    page_dir.replace(backup_dir)
                try:
                    staging_dir.replace(page_dir)
                except Exception:
                    if backup_dir.exists() and not page_dir.exists():
                        backup_dir.replace(page_dir)
                    raise
                missing = object()
                previous_page = state["pages"].get(page_key, missing)
                previous_completed_pages = list(state["completed_pages"])
                previous_failure = state["failed_pages"].get(page_key, missing)
                previous_updated_at = state.get("updated_at", missing)
                try:
                    state["pages"][page_key] = {
                        "status": "ocr_complete_pending_audit",
                        "physical_pdf_page": page_number,
                        "rendered_image_sha256": image_sha256,
                        "elapsed_seconds": elapsed,
                        "result_json_sha256": result_json_sha256,
                        "content_markdown_sha256": content_markdown_sha256,
                        "citation_eligible": False,
                    }
                    state["completed_pages"] = sorted(set(state["completed_pages"] + [page_number]))
                    state["failed_pages"].pop(page_key, None)
                    state["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                    atomic_json(state_path, state)
                except Exception:
                    state["completed_pages"] = previous_completed_pages
                    if previous_page is missing:
                        state["pages"].pop(page_key, None)
                    else:
                        state["pages"][page_key] = previous_page
                    if previous_failure is missing:
                        state["failed_pages"].pop(page_key, None)
                    else:
                        state["failed_pages"][page_key] = previous_failure
                    if previous_updated_at is missing:
                        state.pop("updated_at", None)
                    else:
                        state["updated_at"] = previous_updated_at
                    if backup_dir.exists():
                        page_dir.replace(staging_dir)
                        backup_dir.replace(page_dir)
                        shutil.rmtree(staging_dir)
                    elif page_dir.exists():
                        shutil.rmtree(page_dir)
                    raise
                if backup_dir.exists():
                    try:
                        shutil.rmtree(backup_dir)
                    except Exception as error:
                        print(f"warning {args.document_id} page {page_number}/{page_count}: could not remove backup: {error}", flush=True)
                print(f"done {args.document_id} page {page_number}/{page_count} {elapsed}s", flush=True)
            except Exception:
                if staging_dir.exists():
                    shutil.rmtree(staging_dir)
                raise

        for batch_pages in page_chunks(selected, micro_batch):
            failed_page_keys_before_batch = frozenset(state.get("failed_pages", {}))
            prepared: dict[int, dict] = {}
            try:
                for page_number in batch_pages:
                    page_key = str(page_number)
                    page_dir = pages_dir / f"{page_number:04d}"
                    if not args.force_reprocess and page_number in state["completed_pages"] and (page_dir / "content.md").is_file() and (page_dir / "result.json").is_file():
                        print(f"skip {args.document_id} page {page_number}/{page_count}", flush=True)
                        continue
                    if args.force_reprocess:
                        state["completed_pages"] = [page for page in state["completed_pages"] if page != page_number]
                        state["pages"].pop(page_key, None)
                        atomic_json(state_path, state)
                    image_path = temporary_dir / f"page-{page_number:04d}.png"
                    started = time.monotonic()
                    try:
                        page = document[page_number - 1]
                        bitmap = page.render(scale=args.dpi / 72)
                        bitmap.to_pil().save(image_path)
                        prepared[page_number] = {
                            "image_path": image_path,
                            "image_sha256": sha256(image_path),
                            "started": started,
                        }
                    except Exception as error:
                        image_path.unlink(missing_ok=True)
                        record_failure(page_number, error)

                if not prepared:
                    continue

                if not args.use_queues:
                    page_number = next(iter(prepared))
                    page_data = prepared[page_number]
                    try:
                        results = list(pipeline.predict(str(page_data["image_path"])))
                        if len(results) != 1:
                            raise RuntimeError(f"Expected one page result, received {len(results)}")
                        commit_result(page_number, results[0], page_data["image_sha256"], page_data["started"])
                    except Exception as error:
                        record_failure(page_number, error)
                    continue

                page_images = {page_number: page_data["image_path"] for page_number, page_data in prepared.items()}
                expected_inputs = expected_page_inputs(page_images)
                known_failed_pages = [
                    page_number
                    for page_number in sorted(page_images)
                    if str(page_number) in failed_page_keys_before_batch
                ]
                mapped_results: list[tuple[int, object]] = []
                batch_error: Exception | None = None
                if known_failed_pages:
                    print(
                        f"warning {args.document_id} pages {min(prepared)}-{max(prepared)}/{page_count}: "
                        f"known failed pages {known_failed_pages}; using strict individual prediction",
                        flush=True,
                    )
                else:
                    try:
                        results = pipeline.predict(
                            [str(page_images[page_number]) for page_number in sorted(page_images)],
                            use_queues=True,
                            temperature=0,
                        )
                        mapped_results, _ = validated_queued_results(results, expected_inputs)
                    except Exception as error:
                        batch_error = error

                if not known_failed_pages and batch_error is None:
                    for page_number, result in mapped_results:
                        page_data = prepared[page_number]
                        try:
                            commit_result(page_number, result, page_data["image_sha256"], page_data["started"])
                        except Exception as error:
                            record_failure(page_number, error)
                    continue

                if batch_error is not None:
                    print(
                        f"warning {args.document_id} pages {min(prepared)}-{max(prepared)}/{page_count}: "
                        f"queued prediction rejected; retrying every page individually: "
                        f"{type(batch_error).__name__}: {batch_error}",
                        flush=True,
                    )
                fallback_results, fallback_errors = predict_pages_individually(pipeline, page_images)
                for page_number in sorted(fallback_results):
                    page_data = prepared[page_number]
                    try:
                        commit_result(
                            page_number,
                            fallback_results[page_number],
                            page_data["image_sha256"],
                            page_data["started"],
                        )
                    except Exception as error:
                        record_failure(page_number, error)
                for page_number in sorted(fallback_errors):
                    record_failure(page_number, fallback_errors[page_number])
            finally:
                for page_data in prepared.values():
                    page_data["image_path"].unlink(missing_ok=True)

    state["finished_selected_pages_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    state["selected_pages"] = selected
    state["selected_pages_complete"] = all(page in state["completed_pages"] for page in selected)
    atomic_json(state_path, state)
    if not state["selected_pages_complete"]:
        raise SystemExit(1)


if __name__ == "__main__":
    os.environ.setdefault("PADDLE_PDX_CACHE_HOME", ".cache/paddlex")
    main()
