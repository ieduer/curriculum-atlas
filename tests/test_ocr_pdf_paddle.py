import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "ocr-pdf-paddle.py"
SPEC = importlib.util.spec_from_file_location("ocr_pdf_paddle", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class OcrPdfPaddleHelpersTest(unittest.TestCase):
    def test_page_chunks_preserve_sorted_order_and_remainder(self):
        self.assertEqual(MODULE.page_chunks([2, 4, 6, 8, 10], 2), [[2, 4], [6, 8], [10]])

    def test_page_chunks_reject_out_of_range_size(self):
        for size in (0, 17):
            with self.subTest(size=size), self.assertRaises(ValueError):
                MODULE.page_chunks([1], size)

    def test_micro_batch_requires_explicit_queue_mode(self):
        self.assertEqual(MODULE.effective_micro_batch(1, False), 1)
        self.assertEqual(MODULE.effective_micro_batch(8, True), 8)
        with self.assertRaises(ValueError):
            MODULE.effective_micro_batch(8, False)

    def test_runtime_device_default_is_preserved_and_empty_labels_are_rejected(self):
        self.assertEqual(MODULE.DEFAULT_RUNTIME_DEVICE, "cpu+Metal llama.cpp")
        self.assertEqual(MODULE.validated_runtime_device(MODULE.DEFAULT_RUNTIME_DEVICE), "cpu+Metal llama.cpp")
        self.assertEqual(MODULE.validated_runtime_device("  Kali CUDA llama.cpp  "), "Kali CUDA llama.cpp")
        with self.assertRaises(ValueError):
            MODULE.validated_runtime_device("   ")

    def test_runtime_device_is_backfilled_but_cannot_be_silently_mixed(self):
        configuration = {}
        MODULE.ensure_runtime_device(configuration, "Kali CUDA llama.cpp")
        self.assertEqual(configuration["device"], "Kali CUDA llama.cpp")

    def test_seeded_state_requires_exact_configuration_attempt_identity_and_new_pages_without_tags(self):
        configuration = MODULE.expected_configuration(
            llama_url="http://127.0.0.1:8112/v1",
            dpi=240,
            runtime_device="Kali CUDA llama.cpp",
            vl_rec_max_concurrency=1,
            server_parallel=4,
            micro_batch=16,
            use_queues=True,
            paddle_version="3.3.1",
            paddleocr_version="3.7.0",
            paddlex_version="3.7.2",
        )
        seed_identity = {
            "seed_id": "1" * 64,
            "predecessor_run_identity_sha256": "2" * 64,
            "predecessor_configuration_sha256": "3" * 64,
        }
        tag = dict(seed_identity)
        state = {
            "schema_version": 1,
            "document_id": "doc",
            "source_sha256": "4" * 64,
            "page_count": 2,
            "configuration": configuration,
            "configuration_scope": MODULE.SEED_CONFIGURATION_SCOPE,
            "seed_lineage": {
                "schema_version": 1,
                "mode": MODULE.SEED_MODE,
                **seed_identity,
                "inherited_completed_pages": [1],
                "citation_allowed": False,
            },
            "completed_pages": [1, 2],
            "failed_pages": {},
            "pages": {
                "1": {"seed_provenance": tag},
                "2": {"status": "ocr_complete_pending_audit"},
            },
        }
        MODULE.validate_existing_state(
            state,
            document_id="doc",
            source_sha256="4" * 64,
            page_count=2,
            configuration=configuration,
            seed_identity=seed_identity,
            force_reprocess=False,
        )
        with self.assertRaisesRegex(RuntimeError, "force-reprocess is forbidden"):
            MODULE.validate_existing_state(
                state,
                document_id="doc",
                source_sha256="4" * 64,
                page_count=2,
                configuration=configuration,
                seed_identity=seed_identity,
                force_reprocess=True,
            )
        changed_configuration = dict(configuration)
        changed_configuration["vl_rec_max_concurrency"] = 4
        with self.assertRaisesRegex(RuntimeError, "complete active writer contract"):
            MODULE.validate_existing_state(
                state,
                document_id="doc",
                source_sha256="4" * 64,
                page_count=2,
                configuration=changed_configuration,
                seed_identity=seed_identity,
                force_reprocess=False,
            )
        state["pages"]["2"]["seed_provenance"] = tag
        with self.assertRaisesRegex(RuntimeError, "New OCR page 2"):
            MODULE.validate_existing_state(
                state,
                document_id="doc",
                source_sha256="4" * 64,
                page_count=2,
                configuration=configuration,
                seed_identity=seed_identity,
                force_reprocess=False,
            )
        tampered_lineage = json.loads(json.dumps(state))
        tampered_lineage["pages"]["2"].pop("seed_provenance")
        tampered_lineage["seed_lineage"]["seed_id"] = "9" * 64
        with self.assertRaisesRegex(RuntimeError, "exact hash-bound contract"):
            MODULE.validate_existing_state(
                tampered_lineage,
                document_id="doc",
                source_sha256="4" * 64,
                page_count=2,
                configuration=configuration,
                seed_identity=seed_identity,
                force_reprocess=False,
            )
        MODULE.ensure_runtime_device(configuration, "Kali CUDA llama.cpp")
        with self.assertRaisesRegex(RuntimeError, "refusing to mix OCR runs"):
            MODULE.ensure_runtime_device(configuration, "cpu+Metal llama.cpp")
        self.assertEqual(configuration["device"], "Kali CUDA llama.cpp")

    def test_seed_arguments_are_atomic_and_hash_bound_before_state_or_inference(self):
        complete = types.SimpleNamespace(
            seed_id="1" * 64,
            seed_predecessor_run_identity_sha256="2" * 64,
            seed_predecessor_configuration_sha256="3" * 64,
        )
        self.assertEqual(
            MODULE.validate_seed_arguments(complete),
            {
                "seed_id": "1" * 64,
                "predecessor_run_identity_sha256": "2" * 64,
                "predecessor_configuration_sha256": "3" * 64,
            },
        )
        partial = types.SimpleNamespace(
            seed_id="1" * 64,
            seed_predecessor_run_identity_sha256=None,
            seed_predecessor_configuration_sha256="3" * 64,
        )
        with self.assertRaisesRegex(ValueError, "supplied together"):
            MODULE.validate_seed_arguments(partial)
        malformed = types.SimpleNamespace(
            seed_id="Z" * 64,
            seed_predecessor_run_identity_sha256="2" * 64,
            seed_predecessor_configuration_sha256="3" * 64,
        )
        with self.assertRaisesRegex(ValueError, "lowercase SHA-256"):
            MODULE.validate_seed_arguments(malformed)

    def test_result_input_path_maps_out_of_order_results_to_physical_pages(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            page_images = {11: root / "page-0011.png", 12: root / "page-0012.png"}
            expected = MODULE.expected_page_inputs(page_images)
            returned = set()

            page_number, normalized = MODULE.result_page_number(
                {"input_path": str(page_images[12])}, expected, returned
            )
            self.assertEqual(page_number, 12)
            returned.add(normalized)
            page_number, normalized = MODULE.result_page_number(
                {"input_path": str(page_images[11])}, expected, returned
            )
            self.assertEqual(page_number, 11)
            self.assertEqual(MODULE.missing_result_pages(expected, returned), [11])
            returned.add(normalized)
            self.assertEqual(MODULE.missing_result_pages(expected, returned), [])

    def test_result_input_path_rejects_missing_unknown_and_duplicate_results(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image_path = root / "page-0007.png"
            expected = MODULE.expected_page_inputs({7: image_path})
            normalized = MODULE.normalized_input_path(image_path)

            with self.assertRaisesRegex(ValueError, "missing input_path"):
                MODULE.result_page_number({}, expected, set())
            with self.assertRaisesRegex(ValueError, "Unexpected"):
                MODULE.result_page_number({"input_path": str(root / "other.png")}, expected, set())
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                MODULE.result_page_number({"input_path": str(image_path)}, expected, {normalized})

    def test_queued_result_contract_rejects_valid_prefix_plus_invalid_mapping(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = root / "page-0001.png"
            second = root / "page-0002.png"
            expected = MODULE.expected_page_inputs({1: first, 2: second})
            cases = {
                "duplicate": [
                    {"input_path": str(first)},
                    {"input_path": str(first)},
                ],
                "unknown": [
                    {"input_path": str(first)},
                    {"input_path": str(root / "unknown.png")},
                ],
                "missing input_path": [
                    {"input_path": str(first)},
                    {},
                ],
                "malformed input_path": [
                    {"input_path": str(first)},
                    {"input_path": {"path": str(second)}},
                ],
                "missing expected result": [
                    {"input_path": str(first)},
                ],
            }

            for case, results in cases.items():
                with self.subTest(case=case), self.assertRaises(MODULE.QueuedResultContractError):
                    MODULE.validated_queued_results(results, expected)

    def test_single_page_fallback_isolates_one_peg_failure_from_other_fifteen_pages(self):
        class FakePipeline:
            def __init__(self):
                self.calls = []

            def predict(self, input_path):
                self.calls.append(input_path)
                if Path(input_path).name == "page-0008.png":
                    raise RuntimeError("llama PEG-native 500")
                return [{"input_path": input_path}]

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            page_images = {page: root / f"page-{page:04d}.png" for page in range(1, 17)}
            pipeline = FakePipeline()

            successful, failed = MODULE.predict_pages_individually(pipeline, page_images)

            self.assertEqual(list(successful), [page for page in range(1, 17) if page != 8])
            self.assertEqual(list(failed), [8])
            self.assertRegex(str(failed[8]), "PEG-native 500")
            self.assertEqual(pipeline.calls, [str(page_images[page]) for page in range(1, 17)])

    def test_single_page_fallback_rejects_wrong_input_path_mapping(self):
        class WrongPathPipeline:
            def predict(self, _input_path):
                return [{"input_path": "/tmp/not-the-requested-page.png"}]

        with tempfile.TemporaryDirectory() as temporary:
            image_path = Path(temporary) / "page-0004.png"
            successful, failed = MODULE.predict_pages_individually(
                WrongPathPipeline(),
                {4: image_path},
            )

            self.assertEqual(successful, {})
            self.assertEqual(list(failed), [4])
            self.assertIsInstance(failed[4], MODULE.QueuedResultContractError)
            self.assertRegex(str(failed[4]), "Unexpected Paddle result input_path")

    def test_restart_known_failure_skips_only_its_batch_then_restores_mb16(self):
        class FakeImage:
            def save(self, path):
                Path(path).write_bytes(b"rendered-page")

        class FakeBitmap:
            def to_pil(self):
                return FakeImage()

        class FakePage:
            def render(self, *, scale):
                self.scale = scale
                return FakeBitmap()

        class FakeDocument:
            def __init__(self, _path):
                self.pages = [FakePage() for _ in range(32)]

            def __len__(self):
                return len(self.pages)

            def __getitem__(self, index):
                return self.pages[index]

        class FakeResult:
            def __init__(self, input_path):
                self.input_path = input_path

            def __getitem__(self, key):
                if key != "input_path":
                    raise KeyError(key)
                return self.input_path

            def save_to_json(self, *, save_path):
                Path(save_path).write_text('{"ok":true}\n', encoding="utf-8")

            def save_to_markdown(self, *, save_path):
                markdown_dir = Path(save_path)
                markdown_dir.mkdir(parents=True)
                (markdown_dir / "page.md").write_text("content\n", encoding="utf-8")

        class FakePipeline:
            instances = []

            def __init__(self, **_kwargs):
                self.calls = []
                self.instances.append(self)

            def predict(self, input_value, **kwargs):
                self.calls.append((input_value, kwargs))
                if isinstance(input_value, list):
                    return [FakeResult(input_path) for input_path in reversed(input_value)]
                return [FakeResult(input_value)]

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_pdf = root / "input.pdf"
            input_pdf.write_bytes(b"fake pdf")
            output_root = root / "output"
            output_dir = output_root / "doc"
            output_dir.mkdir(parents=True)
            state_path = output_dir / "state.json"
            state_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "document_id": "doc",
                        "source_sha256": MODULE.sha256(input_pdf),
                        "page_count": 32,
                        "configuration": MODULE.expected_configuration(
                            llama_url="http://127.0.0.1:8112/v1",
                            dpi=240,
                            runtime_device=MODULE.DEFAULT_RUNTIME_DEVICE,
                            vl_rec_max_concurrency=1,
                            server_parallel=1,
                            micro_batch=16,
                            use_queues=True,
                            paddle_version="test",
                            paddleocr_version="test",
                            paddlex_version="test",
                        ),
                        "completed_pages": [],
                        "failed_pages": {"8": {"error": "prior PEG-native 500"}},
                        "pages": {},
                    }
                ),
                encoding="utf-8",
            )

            fake_modules = {
                "paddle": types.SimpleNamespace(__version__="test"),
                "pypdfium2": types.SimpleNamespace(PdfDocument=FakeDocument),
                "paddleocr": types.SimpleNamespace(PaddleOCRVL=FakePipeline),
            }
            argv = [
                str(SCRIPT_PATH),
                "doc",
                str(input_pdf),
                str(output_root),
                "--micro-batch",
                "16",
                "--use-queues",
            ]
            previous_modules = {name: sys.modules.get(name) for name in fake_modules}
            previous_argv = sys.argv
            previous_version = MODULE.importlib.metadata.version
            try:
                sys.modules.update(fake_modules)
                sys.argv = argv
                MODULE.importlib.metadata.version = lambda _package: "test"
                MODULE.main()
            finally:
                for name, previous_module in previous_modules.items():
                    if previous_module is None:
                        sys.modules.pop(name, None)
                    else:
                        sys.modules[name] = previous_module
                sys.argv = previous_argv
                MODULE.importlib.metadata.version = previous_version

            pipeline = FakePipeline.instances[-1]
            self.assertEqual(len(pipeline.calls), 17)
            self.assertEqual(
                [Path(input_value).name for input_value, kwargs in pipeline.calls[:16]],
                [f"page-{page:04d}.png" for page in range(1, 17)],
            )
            self.assertTrue(all(kwargs == {} for _input_value, kwargs in pipeline.calls[:16]))
            queued_inputs, queued_kwargs = pipeline.calls[16]
            self.assertEqual(
                [Path(input_path).name for input_path in queued_inputs],
                [f"page-{page:04d}.png" for page in range(17, 33)],
            )
            self.assertEqual(queued_kwargs, {"use_queues": True, "temperature": 0})
            state = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(state["completed_pages"], list(range(1, 33)))
            self.assertEqual(state["failed_pages"], {})
            self.assertTrue(state["selected_pages_complete"])

    def test_force_reprocess_restores_existing_page_if_state_commit_fails(self):
        class FakeImage:
            def save(self, path):
                Path(path).write_bytes(b"new-image")

        class FakeBitmap:
            def to_pil(self):
                return FakeImage()

        class FakePage:
            def render(self, *, scale):
                self.scale = scale
                return FakeBitmap()

        class FakeDocument:
            def __init__(self, _path):
                self.page = FakePage()

            def __len__(self):
                return 1

            def __getitem__(self, index):
                if index != 0:
                    raise IndexError(index)
                return self.page

        class FakeResult:
            def save_to_json(self, *, save_path):
                Path(save_path).write_text('{"new":true}\n', encoding="utf-8")

            def save_to_markdown(self, *, save_path):
                markdown_dir = Path(save_path)
                markdown_dir.mkdir(parents=True)
                (markdown_dir / "page.md").write_text("new content\n", encoding="utf-8")

        class FakePipeline:
            def __init__(self, **_kwargs):
                pass

            def predict(self, _input):
                return [FakeResult()]

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_pdf = root / "input.pdf"
            input_pdf.write_bytes(b"fake pdf")
            output_root = root / "output"
            output_dir = output_root / "doc"
            page_dir = output_dir / "pages" / "0001"
            page_dir.mkdir(parents=True)
            (page_dir / "result.json").write_text('{"old":true}\n', encoding="utf-8")
            (page_dir / "content.md").write_text("old content\n", encoding="utf-8")
            state_path = output_dir / "state.json"
            state_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "document_id": "doc",
                        "source_sha256": MODULE.sha256(input_pdf),
                        "page_count": 1,
                        "configuration": MODULE.expected_configuration(
                            llama_url="http://127.0.0.1:8112/v1",
                            dpi=240,
                            runtime_device=MODULE.DEFAULT_RUNTIME_DEVICE,
                            vl_rec_max_concurrency=1,
                            server_parallel=1,
                            micro_batch=1,
                            use_queues=False,
                            paddle_version="test",
                            paddleocr_version="test",
                            paddlex_version="test",
                        ),
                        "completed_pages": [1],
                        "failed_pages": {},
                        "pages": {"1": {"status": "ocr_complete_pending_audit"}},
                    }
                ),
                encoding="utf-8",
            )

            real_atomic_json = MODULE.atomic_json
            state_writes = 0

            def fail_completion_write(path, value):
                nonlocal state_writes
                state_writes += 1
                if state_writes == 2:
                    raise OSError("injected state commit failure")
                real_atomic_json(path, value)

            fake_modules = {
                "paddle": types.SimpleNamespace(__version__="test"),
                "pypdfium2": types.SimpleNamespace(PdfDocument=FakeDocument),
                "paddleocr": types.SimpleNamespace(PaddleOCRVL=FakePipeline),
            }
            argv = [
                str(SCRIPT_PATH),
                "doc",
                str(input_pdf),
                str(output_root),
                "--force-reprocess",
            ]
            previous_modules = {name: sys.modules.get(name) for name in fake_modules}
            previous_argv = sys.argv
            previous_version = MODULE.importlib.metadata.version
            previous_atomic_json = MODULE.atomic_json
            try:
                sys.modules.update(fake_modules)
                sys.argv = argv
                MODULE.importlib.metadata.version = lambda _package: "test"
                MODULE.atomic_json = fail_completion_write
                with self.assertRaises(SystemExit) as raised:
                    MODULE.main()
                self.assertEqual(raised.exception.code, 1)
            finally:
                for name, previous_module in previous_modules.items():
                    if previous_module is None:
                        sys.modules.pop(name, None)
                    else:
                        sys.modules[name] = previous_module
                sys.argv = previous_argv
                MODULE.importlib.metadata.version = previous_version
                MODULE.atomic_json = previous_atomic_json

            self.assertEqual((page_dir / "result.json").read_text(encoding="utf-8"), '{"old":true}\n')
            self.assertEqual((page_dir / "content.md").read_text(encoding="utf-8"), "old content\n")
            state = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertNotIn(1, state["completed_pages"])
            self.assertNotIn("1", state["pages"])
            self.assertIn("injected state commit failure", state["failed_pages"]["1"]["error"])


if __name__ == "__main__":
    unittest.main()
