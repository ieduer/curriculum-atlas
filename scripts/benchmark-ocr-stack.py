#!/usr/bin/env python3
import argparse
import hashlib
import importlib.metadata
import json
import platform
import time
from pathlib import Path

import paddle
from paddleocr import PaddleOCRVL, PPStructureV3


DEFAULT_SAMPLES = [
    "/private/tmp/curriculum-atlas-yuwen-samples/page-005.png",
    "/private/tmp/curriculum-atlas-yuwen-samples/page-100.png",
    "/private/tmp/curriculum-atlas-yuwen-samples/page-300.png",
    "/private/tmp/curriculum-atlas-yuwen-samples/page-567.png",
    "/private/tmp/moe-2022-03-page5.png",
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_pipeline(name, pipeline, samples, output_dir):
    result_dir = output_dir / name
    result_dir.mkdir(parents=True, exist_ok=True)
    records = []
    for sample in samples:
        started = time.monotonic()
        sample_records = []
        for index, result in enumerate(pipeline.predict(str(sample))):
            stem = f"{sample.stem}-{index + 1}"
            json_path = result_dir / f"{stem}.json"
            markdown_dir = result_dir / f"{stem}-markdown"
            image_dir = result_dir / f"{stem}-visual"
            result.save_to_json(save_path=str(json_path))
            result.save_to_markdown(save_path=str(markdown_dir))
            result.save_to_img(save_path=str(image_dir))
            sample_records.append({
                "json_path": str(json_path),
                "json_sha256": sha256(json_path),
                "markdown_dir": str(markdown_dir),
                "visual_dir": str(image_dir),
            })
        records.append({
            "image_path": str(sample),
            "image_sha256": sha256(sample),
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "outputs": sample_records,
        })
    return records


def main():
    parser = argparse.ArgumentParser(description="Benchmark the fail-closed curriculum OCR stack.")
    parser.add_argument("--output", default=".cache/ocr-benchmark")
    parser.add_argument("--llama-url", default="http://127.0.0.1:8112/v1")
    parser.add_argument("--vl-rec-max-concurrency", type=int, default=1)
    parser.add_argument(
        "--only",
        choices=("all", "paddleocr-vl", "pp-structure"),
        default="all",
        help="Run one pipeline when resuming a benchmark.",
    )
    parser.add_argument("samples", nargs="*", default=DEFAULT_SAMPLES)
    args = parser.parse_args()

    samples = [Path(path).resolve() for path in args.samples]
    missing = [str(path) for path in samples if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"Missing benchmark samples: {missing}")

    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "paddlepaddle": paddle.__version__,
            "paddleocr": importlib.metadata.version("paddleocr"),
            "paddlex": importlib.metadata.version("paddlex"),
        },
        "configuration": {
            "paddleocr_vl_pipeline_version": "v1.6",
            "vl_rec_backend": "llama-cpp-server",
            "vl_rec_server_url": args.llama_url,
            "vl_rec_max_concurrency": args.vl_rec_max_concurrency,
            "device": "cpu",
            "pp_structure_v3": (
                "official orientation/unwarping/layout/PP-OCRv5 models; "
                "table/formula/chart/seal modules disabled for independent text cross-check"
            ),
        },
        "pipelines": {},
    }

    manifest_path = output_dir / "benchmark-manifest.json"
    if args.only in ("all", "paddleocr-vl"):
        paddleocr_vl = PaddleOCRVL(
            pipeline_version="v1.6",
            vl_rec_backend="llama-cpp-server",
            vl_rec_server_url=args.llama_url,
            vl_rec_max_concurrency=max(1, args.vl_rec_max_concurrency),
            device="cpu",
        )
        manifest["pipelines"]["paddleocr_vl_1_6"] = run_pipeline(
            "paddleocr-vl-1.6", paddleocr_vl, samples, output_dir
        )
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    if args.only in ("all", "pp-structure"):
        pp_structure = PPStructureV3(
            device="cpu",
            use_table_recognition=False,
            use_formula_recognition=False,
            use_chart_recognition=False,
            use_seal_recognition=False,
            use_region_detection=False,
        )
        manifest["pipelines"]["pp_structure_v3"] = run_pipeline(
            "pp-structure-v3", pp_structure, samples, output_dir
        )

    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(manifest_path)


if __name__ == "__main__":
    main()
