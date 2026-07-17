import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildOcrPageFurnitureCandidates,
  parseOcrPageFurnitureArgs,
  writeOcrPageFurnitureCandidates,
} from '../scripts/build-ocr-page-furniture-candidates.mjs';

const SOURCE_SHA = 'a'.repeat(64);
const OTHER_SOURCE_SHA = 'b'.repeat(64);
const IMAGE_SHA = 'c'.repeat(64);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ocr-page-furniture-'));
  return {
    root,
    witnessRoot: path.join(root, 'witness'),
    outputPath: path.join(root, 'output', 'page-furniture.json'),
  };
}

async function writeSidecar(witnessRoot, documentId, page, lines, overrides = {}) {
  const visionRoot = path.join(witnessRoot, documentId, 'vision');
  await mkdir(visionRoot, { recursive: true });
  const key = String(page).padStart(3, '0');
  const target = path.join(visionRoot, `page-${key}.json`);
  const value = {
    schema_version: 3,
    file: `page-${key}.png`,
    document_id: documentId,
    physical_pdf_page: page,
    source_pdf_sha256: SOURCE_SHA,
    rendered_image_sha256: IMAGE_SHA,
    lines: lines.map((text) => ({ text, confidence: 1 })),
    ...overrides,
  };
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}

test('builds deterministic pending-review footer segments and recurring first-line candidates', async () => {
  const value = await fixture();
  await writeSidecar(value.witnessRoot, 'doc-a', 1, ['Running A', 'Body 1', '1']);
  await writeSidecar(value.witnessRoot, 'doc-a', 2, ['Running A', 'Body 2', '2']);
  await writeSidecar(value.witnessRoot, 'doc-a', 3, ['Chapter', 'Body 3', '10']);
  await writeSidecar(value.witnessRoot, 'doc-a', 4, ['Running B', 'Body 4', '11']);
  await writeSidecar(value.witnessRoot, 'doc-a', 5, ['Running B', 'Body 5', '12']);
  await writeSidecar(value.witnessRoot, 'doc-a', 6, ['Body only']);

  const first = await buildOcrPageFurnitureCandidates({ witnessRoot: value.witnessRoot });
  const second = await buildOcrPageFurnitureCandidates({ witnessRoot: value.witnessRoot });
  assert.deepEqual(second, first);
  assert.equal(first.policy.raw_witness_mutation, 'none');
  assert.equal(first.policy.audit_filter_mutation, 'none');
  assert.equal(first.summary.documents, 1);
  assert.equal(first.summary.observed_pages, 6);
  assert.equal(first.summary.footer_candidate_segments, 2);
  assert.equal(first.summary.footer_candidate_pages, 5);
  assert.equal(first.summary.recurring_first_line_candidates, 2);
  assert.equal(first.summary.ignored_noncanonical_files, 0);
  assert.equal(first.summary.eligible_for_audit_filter, 0);

  const document = first.documents[0];
  assert.equal(document.document_id, 'doc-a');
  assert.equal(document.source_pdf_sha256, SOURCE_SHA);
  assert.equal(document.eligible_for_audit_filter, false);
  assert.deepEqual(document.footer_candidates, [
    {
      candidate_type: 'printed_page_number_footer',
      start_page: 1,
      end_page: 2,
      page_count: 2,
      physical_to_printed_offset: 0,
      printed_page_start: 1,
      printed_page_end: 2,
      example_pages: [1, 2],
      review_status: 'pending_image_review',
      eligible_for_audit_filter: false,
    },
    {
      candidate_type: 'printed_page_number_footer',
      start_page: 3,
      end_page: 5,
      page_count: 3,
      physical_to_printed_offset: 7,
      printed_page_start: 10,
      printed_page_end: 12,
      example_pages: [3, 4, 5],
      review_status: 'pending_image_review',
      eligible_for_audit_filter: false,
    },
  ]);
  assert.deepEqual(
    document.recurring_first_line_candidates.map((candidate) => ({
      text: candidate.normalized_text,
      count: candidate.occurrence_count,
      pages: candidate.pages,
      eligible: candidate.eligible_for_audit_filter,
    })),
    [
      { text: 'Running A', count: 2, pages: [1, 2], eligible: false },
      { text: 'Running B', count: 2, pages: [4, 5], eligible: false },
    ],
  );

  await writeOcrPageFurnitureCandidates({
    witnessRoot: value.witnessRoot,
    outputPath: value.outputPath,
  });
  const firstOutput = await readFile(value.outputPath, 'utf8');
  await writeOcrPageFurnitureCandidates({
    witnessRoot: value.witnessRoot,
    outputPath: value.outputPath,
  });
  assert.equal(await readFile(value.outputPath, 'utf8'), firstOutput);
});

test('fails closed on conflicting document source hashes without replacing output', async () => {
  const value = await fixture();
  await writeSidecar(value.witnessRoot, 'doc-a', 1, ['Header', '1']);
  await writeSidecar(value.witnessRoot, 'doc-a', 2, ['Header', '2'], {
    source_pdf_sha256: OTHER_SOURCE_SHA,
  });
  await assert.rejects(
    writeOcrPageFurnitureCandidates({
      witnessRoot: value.witnessRoot,
      outputPath: value.outputPath,
    }),
    /conflicting source_pdf_sha256 values/,
  );
  await assert.rejects(access(value.outputPath), /ENOENT/);
});

test('fails closed on malformed or identity-drifting sidecars', async (t) => {
  await t.test('malformed JSON', async () => {
    const value = await fixture();
    const visionRoot = path.join(value.witnessRoot, 'doc-a', 'vision');
    await mkdir(visionRoot, { recursive: true });
    await writeFile(path.join(visionRoot, 'page-001.json'), '{"lines":');
    await assert.rejects(
      buildOcrPageFurnitureCandidates({ witnessRoot: value.witnessRoot }),
      /contains invalid JSON/,
    );
  });

  await t.test('physical page mismatch', async () => {
    const value = await fixture();
    await writeSidecar(value.witnessRoot, 'doc-a', 1, ['Header', '1'], {
      physical_pdf_page: 2,
    });
    await assert.rejects(
      buildOcrPageFurnitureCandidates({ witnessRoot: value.witnessRoot }),
      /physical_pdf_page does not match its filename/,
    );
  });

  await t.test('noncanonical diagnostic sidecar is recorded but excluded', async () => {
    const value = await fixture();
    const visionRoot = path.join(value.witnessRoot, 'doc-a', 'vision');
    await mkdir(visionRoot, { recursive: true });
    await writeFile(path.join(visionRoot, 'page-latest.json'), '{}\n');
    await writeSidecar(value.witnessRoot, 'doc-a', 1, ['Header', '1']);
    const artifact = await buildOcrPageFurnitureCandidates({ witnessRoot: value.witnessRoot });
    assert.equal(artifact.summary.observed_pages, 1);
    assert.equal(artifact.summary.ignored_noncanonical_files, 1);
    assert.deepEqual(artifact.documents[0].ignored_noncanonical_files, [
      'doc-a/vision/page-latest.json',
    ]);
  });
});

test('requires output outside the read-only witness root', async () => {
  const value = await fixture();
  await writeSidecar(value.witnessRoot, 'doc-a', 1, ['Header', '1']);
  await assert.rejects(
    writeOcrPageFurnitureCandidates({
      witnessRoot: value.witnessRoot,
      outputPath: path.join(value.witnessRoot, 'derived.json'),
    }),
    /output must be outside/,
  );
});

test('CLI arguments require one witness root and one output path', () => {
  assert.deepEqual(
    parseOcrPageFurnitureArgs(['--witness-root', 'witness', '--output', 'furniture.json']),
    { witnessRoot: 'witness', outputPath: 'furniture.json' },
  );
  assert.throws(
    () => parseOcrPageFurnitureArgs(['--witness-root', 'witness']),
    /--output is required/,
  );
  assert.throws(
    () => parseOcrPageFurnitureArgs([
      '--witness-root', 'one',
      '--witness-root', 'two',
      '--output', 'furniture.json',
    ]),
    /duplicate argument/,
  );
});
