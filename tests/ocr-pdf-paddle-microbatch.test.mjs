import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../scripts/ocr-pdf-paddle.py', import.meta.url), 'utf8');
const legacyB1Source = readFileSync(
  new URL('./fixtures/remote-ocr/b1/ocr-pdf-paddle.py', import.meta.url),
  'utf8',
);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('B1-to-seed-aware source transition is hash-bound and leaves the inference/artifact suffix byte-identical', () => {
  assert.equal(
    sha256(legacyB1Source),
    'b4ea873026fb4d2da2efb921ddac3974a48db703143ff53aff3ebeae48d9b048',
  );
  assert.equal(
    sha256(source),
    '3176d267c681b2764d4ff81f7e7b6748c174ee62854a11a2529ccfb355a364f3',
  );
  const suffixMarker = '    pipeline = PaddleOCRVL(';
  const legacySuffixOffset = legacyB1Source.indexOf(suffixMarker);
  const currentSuffixOffset = source.indexOf(suffixMarker);
  assert.notEqual(legacySuffixOffset, -1);
  assert.notEqual(currentSuffixOffset, -1);
  const legacySuffix = legacyB1Source.slice(legacySuffixOffset);
  const currentSuffix = source.slice(currentSuffixOffset);
  assert.equal(Buffer.byteLength(legacySuffix), 11_430);
  assert.equal(Buffer.byteLength(currentSuffix), 11_430);
  assert.equal(
    sha256(currentSuffix),
    '4edade704624f0bac5bcd76eeb113a07452a57040e4fd949609d319f49c2b4ca',
  );
  assert.equal(currentSuffix, legacySuffix);
  for (const writer of [legacyB1Source, source]) {
    assert.match(writer, /parser\.add_argument\("--dpi", type=int, default=240\)/);
  }
  assert.match(currentSuffix, /PaddleOCRVL\([\s\S]*pipeline_version="v1\.6"/);
  assert.match(currentSuffix, /vl_rec_backend="llama-cpp-server"/);
  assert.match(currentSuffix, /device="cpu"/);
  assert.match(currentSuffix, /page\.render\(scale=args\.dpi \/ 72\)/);
  assert.match(currentSuffix, /"citation_eligible": False/);
});

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

test('runtime provenance is complete and immutable before any resumed state write', () => {
  assert.match(source, /DEFAULT_RUNTIME_DEVICE = "cpu\+Metal llama\.cpp"/);
  assert.match(source, /parser\.add_argument\("--runtime-device", default=DEFAULT_RUNTIME_DEVICE/);
  assert.match(source, /def expected_configuration\(/);
  assert.match(source, /state\.get\("configuration"\) != configuration/);
  assert.match(source, /complete active writer contract/);
  assert.doesNotMatch(source, /configuration\["vl_rec_max_concurrency"\] = args\.vl_rec_max_concurrency/);
  assert.match(source, /--force-reprocess is forbidden for hash-bound seeded OCR runs/);
  assert.match(source, /New OCR page \{page\} must not carry seed provenance/);
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
