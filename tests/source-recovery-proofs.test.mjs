import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { sourceManifest } from '../scripts/source-manifest.mjs';
import { validateSourceRecoveryProofs } from '../scripts/validate-source-recovery-proofs.mjs';

const root = new URL('../', import.meta.url);
const [proofs, artifactRegistry, releasePolicy, documentSources] = await Promise.all([
  readFile(new URL('data/source-recovery-proofs.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('data/artifact-registry.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('data/release-assets-policy.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('data/document-sources.json', root), 'utf8').then(JSON.parse),
]);
const ocrQueue = JSON.parse(await readFile(new URL('data/ocr-queue.json', root), 'utf8'));

function fixture() {
  return {
    proofs: structuredClone(proofs),
    catalog: { documents: structuredClone(sourceManifest) },
    artifactRegistry: structuredClone(artifactRegistry),
    ocrQueue: structuredClone(ocrQueue),
  };
}

function identityHash(record, fields) {
  return createHash('sha256')
    .update(JSON.stringify(fields.map((field) => record[field] ?? null)))
    .digest('hex');
}

async function validate(value) {
  return validateSourceRecoveryProofs({
    root,
    ...value,
    requireLocal: false,
  });
}

async function validateLocal(value) {
  return validateSourceRecoveryProofs({
    root,
    ...value,
    requireLocal: true,
    deepArchive: true,
  });
}

test('source recovery proof structurally binds all recovered works and stays fail closed', async () => {
  const report = await validate(fixture());
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.deepEqual(report.counts, {
    corrupt_recoveries: 2,
    official_archives: 1,
    archive_members: 21,
    official_same_work_scans: 16,
    native_attachments: 5,
    unresolved_conflicts: 1,
    canonical_pdf_documents: 149,
    queue_documents: 86,
  });
});

test('source recovery proof and schema are immutable public release metadata', () => {
  const requiredSources = new Set([
    'data/source-recovery-online-receipt.json',
    'data/source-recovery-online-receipt.schema.json',
    'data/source-recovery-proofs.json',
    'data/source-recovery-proofs.schema.json',
  ]);
  const inventory = new Map(releasePolicy.data_inventory.files.map((entry) => [entry.path, entry]));
  const r2Sources = new Set(releasePolicy.r2.objects.map((entry) => entry.source));
  const governedSources = new Set(releasePolicy.r2.governed_source_files);

  for (const source of requiredSources) {
    assert.equal(inventory.get(source)?.disposition, 'r2_public_metadata', source);
    assert.equal(r2Sources.has(source), true, source);
    assert.equal(governedSources.has(source), true, source);
  }
});

test('the catalog URL is the only primary source for every recovered document', () => {
  const catalogById = new Map(sourceManifest.map((record) => [record.id, record]));
  for (const source of documentSources.sources) {
    const catalog = catalogById.get(source.document_id);
    assert.ok(catalog, source.document_id);
    const expectedPrimary = source.source_url === catalog.source_url ? 1 : 0;
    assert.equal(source.is_primary, expectedPrimary, `${source.document_id}: ${source.source_url}`);
  }

  for (const [documentId, corruptSha256] of [
    ['ictr-2a9f8ddd4169', '5711024837310d68c30741142fb9b26cf75a040f703452395817e4cdb60c7263'],
    ['ictr-24bb45bda31b', '4047001069c1999c1e9c8917a6f7c381a401924bf012d1e3b395dbbe8578778a'],
  ]) {
    const quarantined = documentSources.sources.find((source) => (
      source.document_id === documentId && source.checksum_sha256 === corruptSha256
    ));
    assert.ok(quarantined, documentId);
    assert.equal(quarantined.is_primary, 0);
    assert.equal(quarantined.artifact_disposition, 'quarantine');
    assert.doesNotMatch(quarantined.note, /zero-filled payload|全零/u);
  }
});

test('a corrupt endpoint cannot be relabelled all-zero or removed from quarantine', async () => {
  for (const mutation of [
    (value) => {
      value.artifactRegistry.artifacts.find((item) => (
        item.intended_document_id === 'ictr-2a9f8ddd4169'
      )).note = '文件为全零载荷。';
    },
    (value) => {
      value.artifactRegistry.artifacts = value.artifactRegistry.artifacts.filter((item) => (
        item.intended_document_id !== 'ictr-24bb45bda31b'
      ));
    },
  ]) {
    const value = fixture();
    mutation(value);
    const report = await validate(value);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((error) => error.code === 'quarantine_binding'));
  }
});

test('same title or caller-selected scan cannot cross a work/version boundary', async () => {
  const value = fixture();
  value.proofs.official_same_work_scan_variants[0][0] = 'ictr-f4258201b960';
  const report = await validate(value);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => (
    error.code === 'scan_variant_identity' || error.code === 'scan_2003_coverage'
  )));
});

test('official archive membership must bind the exact catalog work, hash, and page count', async () => {
  const value = fixture();
  const physics = value.proofs.official_archives[0].members.find((item) => item[0] === 'ictr-2a9f8ddd4169');
  physics[3] = '0'.repeat(64);
  const report = await validate(value);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.code === 'archive_member_catalog_binding'));
});

test('recovered artifacts bind the exact official archive and physical member page count', async () => {
  for (const mutation of [
    (value) => {
      value.proofs.corrupt_payload_recoveries.find((item) => (
        item.document_id === 'ictr-2a9f8ddd4169'
      )).recovered_artifact.source_archive_sha256 = '0'.repeat(64);
    },
    (value) => {
      const member = value.proofs.official_archives[0].members.find((item) => (
        item[0] === 'ictr-a71e3780f934'
      ));
      member[5] += 1;
      value.catalog.documents.find((item) => item.id === member[0]).page_count = member[5];
    },
  ]) {
    const value = fixture();
    mutation(value);
    const report = await validateLocal(value);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((error) => [
      'archive_recovery_binding',
      'archive_member_pages',
    ].includes(error.code)), JSON.stringify(report.errors));
  }
});

test('catalog work and version identity cannot drift behind a matching title', async () => {
  for (const [field, replacement] of [
    ['version_label', '2017年版'],
    ['stage', '义务教育'],
    ['issued_by', '未核实发布机构'],
    ['issued_date', '2017-01-01'],
    ['current_status', 'current'],
  ]) {
    const value = fixture();
    value.catalog.documents.find((item) => item.id === 'ictr-24bb45bda31b')[field] = replacement;
    const report = await validate(value);
    assert.equal(report.ok, false, field);
    assert.ok(report.errors.some((error) => error.code === 'catalog_work_version_binding'), field);
  }
});

test('canonical artifacts cannot drift behind an unchanged work identity', async () => {
  for (const [field, replacement] of [
    ['local_cache_path', '.cache/source-recovery/moe-2017/wrong.pdf'],
    ['source_url', 'https://www.moe.gov.cn/srcsite/A26/s8001/201801/wrong.rar'],
    ['checksum_sha256', '0'.repeat(64)],
    ['page_count', 99],
  ]) {
    const value = fixture();
    value.catalog.documents.find((item) => item.id === 'ictr-2a9f8ddd4169')[field] = replacement;
    const report = await validate(value);
    assert.equal(report.ok, false, field);
    assert.ok(report.errors.some((error) => [
      'catalog_canonical_artifact_binding',
      'archive_member_catalog_binding',
      'canonical_recovery_catalog_binding',
    ].includes(error.code)), `${field}: ${JSON.stringify(report.errors)}`);
  }
});

test('only the two named corrupt recovery documents map one-to-one to quarantine artifacts', async () => {
  for (const mutation of [
    (value) => {
      value.proofs.corrupt_payload_recoveries[0].document_id = 'ictr-a71e3780f934';
    },
    (value) => {
      value.artifactRegistry.artifacts.push({
        ...structuredClone(value.artifactRegistry.artifacts.find((item) => (
          item.intended_document_id === 'ictr-2a9f8ddd4169'
        ))),
        artifact_id: 'quarantine-duplicate-physics',
      });
    },
    (value) => {
      value.proofs.corrupt_payload_recoveries[0].quarantine_artifact_id =
        'quarantine-ictr-english-experimental-zero-prefix-corrupt';
    },
  ]) {
    const value = fixture();
    mutation(value);
    const report = await validate(value);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((error) => [
      'corrupt_recovery_coverage',
      'quarantine_binding',
      'quarantine_one_to_one',
    ].includes(error.code)), JSON.stringify(report.errors));
  }
});

test('every queued record remains exactly bound to its canonical catalog PDF', async () => {
  const value = fixture();
  value.ocrQueue.documents.find((item) => item.id === 'ictr-24bb45bda31b').source_sha256 = '0'.repeat(64);
  const report = await validate(value);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.code === 'queue_catalog_binding'));
});

test('canonical PDF and OCR queue universes cannot lose an otherwise valid record', async () => {
  for (const mutation of [
    (value) => {
      value.catalog.documents = value.catalog.documents.filter((item) => item.id !== 'ictr-559f488c0309');
    },
    (value) => {
      value.ocrQueue.documents = value.ocrQueue.documents.filter((item) => item.id !== 'moe-2022-17');
    },
  ]) {
    const value = fixture();
    mutation(value);
    const report = await validate(value);
    assert.equal(report.ok, false, JSON.stringify(report.counts));
    assert.ok(report.errors.some((error) => [
      'canonical_pdf_universe',
      'ocr_queue_universe',
    ].includes(error.code)), JSON.stringify(report.errors));
  }
});

test('the complete OCR queue row contract is immutable, not only path/hash/page identity', async () => {
  const value = fixture();
  const queued = value.ocrQueue.documents.find((item) => item.id === 'moe-2011-01');
  Object.assign(queued, {
    title: '错误标题',
    subject: '错误学科',
    source_tier: 'unreviewed',
    input_quality_status: 'accepted',
    priority: -1,
    policy: 'caller_selected',
  });
  const report = await validate(value);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.code === 'ocr_queue_universe'));
});

test('identity tuples distinguish a missing key from an explicit null', async () => {
  for (const field of ['issued_date', 'native_text_cache_path']) {
    const value = fixture();
    delete value.catalog.documents.find((item) => item.id === 'ictr-c96cc01ca832')[field];
    const report = await validate(value);
    assert.equal(report.ok, false, field);
    assert.ok(report.errors.some((error) => [
      'catalog_work_identity_shape',
      'catalog_canonical_artifact_identity_shape',
    ].includes(error.code)), `${field}: ${JSON.stringify(report.errors)}`);
  }
});

test('coordinated work relabelling cannot self-authorize by recomputing proof hashes', async () => {
  const value = fixture();
  const ids = ['ictr-6aed243f91fa', 'ictr-0bcfe4b915df'];
  const [left, right] = ids.map((id) => value.catalog.documents.find((item) => item.id === id));
  const fields = value.proofs.work_identity_fields.filter((field) => field !== 'id');
  const leftValues = Object.fromEntries(fields.map((field) => [field, left[field]]));
  for (const field of fields) left[field] = right[field];
  for (const field of fields) right[field] = leftValues[field];
  for (const document of [left, right]) {
    value.proofs.catalog_identity_sha256_by_document[document.id] = identityHash(
      document,
      value.proofs.work_identity_fields,
    );
    const tuple = value.proofs.official_same_work_scan_variants.find((item) => item[0] === document.id);
    tuple[1] = document.title;
  }
  const report = await validate(value);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.code === 'immutable_identity_baseline'));
});

test('coordinated canonical artifact swaps cannot self-authorize by recomputing proof hashes', async () => {
  const value = fixture();
  const members = value.proofs.official_archives[0].members;
  const [leftTuple, rightTuple] = members.slice(0, 2);
  const [left, right] = [leftTuple[0], rightTuple[0]]
    .map((id) => value.catalog.documents.find((item) => item.id === id));
  const artifactFields = value.proofs.canonical_artifact_identity_fields.filter((field) => field !== 'id');
  const leftValues = Object.fromEntries(artifactFields.map((field) => [field, left[field]]));
  for (const field of artifactFields) left[field] = right[field];
  for (const field of artifactFields) right[field] = leftValues[field];
  const leftArtifactTuple = leftTuple.slice(2);
  leftTuple.splice(2, 4, ...rightTuple.slice(2));
  rightTuple.splice(2, 4, ...leftArtifactTuple);
  for (const document of [left, right]) {
    value.proofs.catalog_canonical_artifact_sha256_by_document[document.id] = identityHash(
      document,
      value.proofs.canonical_artifact_identity_fields,
    );
  }
  const report = await validate(value);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.code === 'immutable_identity_baseline'));
});

test('every canonical catalog PDF is physically page-counted, not only recovery proof members', async () => {
  const value = fixture();
  value.catalog.documents.find((item) => item.id === 'moe-2022-02').page_count += 1;
  value.ocrQueue.documents.find((item) => item.id === 'moe-2022-02').page_count += 1;
  const report = await validateLocal(value);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.code === 'canonical_pdf_pages'));
});

test('canonical recovered, scan, and Office sources bind their exact official URLs', async () => {
  for (const documentId of [
    'ictr-2a9f8ddd4169',
    'ictr-24bb45bda31b',
    'ictr-a027c4d6e30e',
  ]) {
    const value = fixture();
    value.catalog.documents.find((item) => item.id === documentId).source_url = 'https://example.invalid/drift';
    const report = await validate(value);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((error) => [
      'canonical_recovery_catalog_binding',
      'scan_canonical_binding',
      'attachment_catalog_binding',
    ].includes(error.code)), `${documentId}: ${JSON.stringify(report.errors)}`);
  }
});

test('the legacy exact-tail identity witness cannot disappear from catalog lineage', async () => {
  const value = fixture();
  value.catalog.documents.find((item) => item.id === 'ictr-24bb45bda31b').scan_variants = [];
  const report = await validate(value);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.code === 'identity_recovery_catalog_binding'));
});

test('unresolved attachment revision conflicts cannot be omitted or cited as settled text', async () => {
  for (const mutation of [
    (value) => {
      value.proofs.native_attachments.find((item) => (
        item.document_id === 'ictr-a027c4d6e30e'
      )).conflicts = [];
    },
    (value) => {
      value.catalog.documents.find((item) => item.id === 'ictr-a027c4d6e30e').citation_allowed = true;
    },
  ]) {
    const value = fixture();
    mutation(value);
    const report = await validate(value);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((error) => [
      'attachment_conflict_omitted',
      'attachment_catalog_binding',
    ].includes(error.code)));
  }
});

test('Office metadata page counts cannot become stable citation locators', async () => {
  const value = fixture();
  value.catalog.documents.find((item) => item.id === 'ictr-cfb2a39a2016').page_count = 23;
  const report = await validate(value);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.code === 'attachment_catalog_binding'));
});
