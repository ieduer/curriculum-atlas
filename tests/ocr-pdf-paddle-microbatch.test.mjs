import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../scripts/ocr-pdf-paddle.py', import.meta.url), 'utf8');

test('queued micro-batching is explicit, bounded, deterministic, and path-mapped', () => {
  assert.match(source, /parser\.add_argument\("--micro-batch", type=int, default=1/);
  assert.match(source, /parser\.add_argument\("--use-queues", action="store_true"/);
  assert.match(source, /value < 1 or value > 16/);
  assert.match(source, /pipeline\.predict\([\s\S]*use_queues=True,[\s\S]*temperature=0,/);
  assert.match(source, /result_page_number\(result, expected_inputs, returned_inputs\)/);
  assert.match(source, /raw_input_path = result\["input_path"\]/);
  assert.match(source, /queued prediction rejected; retrying every page individually/);
  assert.match(source, /failed_page_keys_before_batch = frozenset\(state\.get\("failed_pages", \{\}\)\)/);
  assert.match(source, /known failed pages \{known_failed_pages\}; using strict individual prediction/);
  assert.match(source, /if not known_failed_pages and batch_error is None:/);
  assert.match(source, /predict_pages_individually\(pipeline, page_images\)/);
});

test('runtime provenance defaults locally and rejects mixed-device continuation', () => {
  assert.match(source, /DEFAULT_RUNTIME_DEVICE = "cpu\+Metal llama\.cpp"/);
  assert.match(source, /parser\.add_argument\("--runtime-device", default=DEFAULT_RUNTIME_DEVICE/);
  assert.match(source, /ensure_runtime_device\(configuration, runtime_device\)/);
  assert.match(source, /refusing to mix OCR runs/);
  assert.match(source, /"device": runtime_device/);
});

test('per-page evidence and publication gates remain intact', () => {
  assert.match(source, /rendered_image_sha256/);
  assert.match(source, /result_json_sha256/);
  assert.match(source, /content_markdown_sha256/);
  assert.match(source, /"physical_pdf_page": page_number/);
  assert.match(source, /"citation_eligible": False/);
  assert.match(source, /staging_dir\.replace\(page_dir\)/);
  assert.match(source, /state\["failed_pages"\]\[page_key\]/);
});
