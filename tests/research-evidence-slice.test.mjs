import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  buildResearchSourceRegistry,
  canonicalJson,
  canonicalizeHtmlText,
  projectResearchEvidenceSlice,
  researchCorpusRowsetSha256,
  validateResearchEvidenceSlice,
} from '../scripts/lib/research-evidence-slice.mjs';
import { assertResearchEvidenceReleaseGate } from '../scripts/validate-research-evidence-slice.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'curriculum-research-evidence-'));
  const databasePath = path.join(root, 'corpus.sqlite');
  const corpusManifestPath = path.join(root, 'manifest.json');
  const fromPdfPath = path.join(root, 'from.pdf');
  const toPdfPath = path.join(root, 'to.pdf');
  const fromHtmlPath = path.join(root, 'from.html');
  const toHtmlPath = path.join(root, 'to.html');
  const fromIdentityPath = path.join(root, 'from-identity.html');
  const toIdentityPath = path.join(root, 'to-identity.html');
  const mirrorPath = path.join(root, 'mirror.pdf');
  const fromPageImagePath = path.join(root, 'from-page.png');
  const toPageImagePath = path.join(root, 'to-page.png');

  const fromPdf = Buffer.from('%PDF-1.7\nfixture-from-pdf\n%%EOF');
  const toPdf = Buffer.from('%PDF-1.7\nfixture-to-pdf\n%%EOF');
  const fromHtml = Buffer.from('<html><body><p>旧版精确表述</p><p>冲突版本表述</p></body></html>');
  const toHtml = Buffer.from('<html><body><p>新版精确表述</p></body></html>');
  const fromIdentity = Buffer.from('<html><body><h1>教育部发布旧版课程标准</h1></body></html>');
  const toIdentity = Buffer.from('<html><body><h1>教育部发布新版修订课程标准</h1></body></html>');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const fromPageImage = Buffer.concat([png, Buffer.from('from')]);
  const toPageImage = Buffer.concat([png, Buffer.from('to')]);
  await Promise.all([
    writeFile(fromPdfPath, fromPdf),
    writeFile(toPdfPath, toPdf),
    writeFile(fromHtmlPath, fromHtml),
    writeFile(toHtmlPath, toHtml),
    writeFile(fromIdentityPath, fromIdentity),
    writeFile(toIdentityPath, toIdentity),
    writeFile(mirrorPath, toPdf),
    writeFile(fromPageImagePath, fromPageImage),
    writeFile(toPageImagePath, toPageImage),
  ]);

  const releaseId = `corpus-${'1'.repeat(24)}`;
  const corpusManifest = {
    schema_version: 1,
    release_id: releaseId,
    release_fingerprint_sha256: '2'.repeat(64),
    documents: 2,
    paragraphs: 2,
    page_publication_gates: 2,
  };
  const corpusManifestRaw = `${JSON.stringify(corpusManifest, null, 2)}\n`;
  await writeFile(corpusManifestPath, corpusManifestRaw);

  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE documents(
      id TEXT PRIMARY KEY,title TEXT,subject TEXT,stage TEXT,document_type TEXT,
      version_label TEXT,issued_by TEXT,sort_year INTEGER,checksum_sha256 TEXT,
      text_quality_status TEXT,citation_allowed INTEGER,corpus_release_id TEXT
    );
    CREATE TABLE document_classifications(
      document_id TEXT PRIMARY KEY,taxonomy_entity_kind TEXT,canonical_subject TEXT,display_facet TEXT
    );
    CREATE TABLE paragraphs(
      id INTEGER PRIMARY KEY,document_id TEXT,ordinal INTEGER,page_number INTEGER,body TEXT,
      body_sha256 TEXT,display_allowed INTEGER,citation_allowed INTEGER,source_artifact_sha256 TEXT,
      page_final_text_sha256 TEXT,provenance_locator TEXT,corpus_release_id TEXT
    );
    CREATE TABLE page_publication_gates(
      document_id TEXT,page_number INTEGER,source_artifact_sha256 TEXT,final_text_sha256 TEXT,
      stable_locator TEXT,publication_basis TEXT,review_status TEXT,display_allowed INTEGER,
      citation_allowed INTEGER,corpus_release_id TEXT,PRIMARY KEY(document_id,page_number)
    );
  `);
  const insertDocument = database.prepare(`INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertDocument.run('doc-from', '旧版', '语文', '普通高中', '课程标准', '2017年版', '教育部', 2017, sha256(fromPdf), 'official_native_text', 1, releaseId);
  insertDocument.run('doc-to', '新版', '语文', '普通高中', '课程标准', '2017年版2020年修订', '教育部', 2020, sha256(toPdf), 'official_native_text', 1, releaseId);
  database.prepare('INSERT INTO document_classifications VALUES(?,?,?,?)').run('doc-from', 'subject', '语文', '语文');
  database.prepare('INSERT INTO document_classifications VALUES(?,?,?,?)').run('doc-to', 'subject', '语文', '语文');

  const fromBody = '段落前旧版精确表述段落后';
  const toBody = '段落前新版精确表述段落后';
  const fromPageHash = sha256('from-page');
  const toPageHash = sha256('to-page');
  const insertParagraph = database.prepare(`INSERT INTO paragraphs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertParagraph.run(101, 'doc-from', 1, 11, fromBody, sha256(fromBody), 1, 1, sha256(fromPdf), fromPageHash, 'doc-from:page:11:block:1', releaseId);
  insertParagraph.run(202, 'doc-to', 1, 9, toBody, sha256(toBody), 1, 1, sha256(toPdf), toPageHash, 'doc-to:page:9:block:1', releaseId);
  const insertPage = database.prepare(`INSERT INTO page_publication_gates VALUES(?,?,?,?,?,?,?,?,?,?)`);
  insertPage.run('doc-from', 11, sha256(fromPdf), fromPageHash, 'doc-from:page:11', 'official_native_text', 'official_native_text', 1, 1, releaseId);
  insertPage.run('doc-to', 9, sha256(toPdf), toPageHash, 'doc-to:page:9', 'official_native_text', 'official_native_text', 1, 1, releaseId);
  database.close();

  const fromCanonical = canonicalizeHtmlText(fromHtml.toString('utf8'));
  const toCanonical = canonicalizeHtmlText(toHtml.toString('utf8'));
  const fromIdentityCanonical = canonicalizeHtmlText(fromIdentity.toString('utf8'));
  const toIdentityCanonical = canonicalizeHtmlText(toIdentity.toString('utf8'));
  const span = (id, text, body, purpose, evidenceId = null) => {
    const utf16Start = body.indexOf(text);
    return {
      span_id: id,
      purpose,
      evidence_id: evidenceId,
      utf16_start: utf16Start,
      utf16_end: utf16Start + text.length,
      exact_text: text,
      exact_text_sha256: sha256(text),
      occurrence_index: 0,
    };
  };
  const fromConflictSpan = span(
    'online-span:from-conflict',
    '冲突版本表述',
    fromCanonical,
    'transcription_conflict',
    'evidence:from',
  );

  const sources = [
    {
      source_id: 'source:from-primary',
      title: '旧版 PDF',
      publisher: '教育部',
      url: 'https://example.edu/from.pdf',
      authority_class: 'ministry_primary',
      evidence_role: 'primary_artifact',
      version_relation: 'exact_document_exact_edition',
      independently_counts_for_text: false,
      witness_scope: 'artifact_identity_only',
      same_artifact_as: null,
      document_binding: {
        document_id: 'doc-from', version_label: '2017年版',
        source_artifact_sha256: sha256(fromPdf), version_identity_source_id: 'source:from-identity',
      },
      resource: { resource_id: 'artifact:from', media_type: 'application/pdf', sha256: sha256(fromPdf) },
      canonical_text_sha256: null,
      spans: [],
      limitations: ['原始制品不重复计作在线独立文本。'],
    },
    {
      source_id: 'source:to-primary',
      title: '新版 PDF',
      publisher: '教育部',
      url: 'https://example.edu/to.pdf',
      authority_class: 'ministry_primary',
      evidence_role: 'primary_artifact',
      version_relation: 'exact_document_exact_edition',
      independently_counts_for_text: false,
      witness_scope: 'artifact_identity_only',
      same_artifact_as: null,
      document_binding: {
        document_id: 'doc-to', version_label: '2017年版2020年修订',
        source_artifact_sha256: sha256(toPdf), version_identity_source_id: 'source:to-identity',
      },
      resource: { resource_id: 'artifact:to', media_type: 'application/pdf', sha256: sha256(toPdf) },
      canonical_text_sha256: null,
      spans: [],
      limitations: ['原始制品不重复计作在线独立文本。'],
    },
    {
      source_id: 'source:from-identity',
      title: '旧版官方发布页',
      publisher: '教育部',
      url: 'https://example.gov/from',
      authority_class: 'ministry_official_web',
      evidence_role: 'official_version_identity',
      version_relation: 'exact_document_exact_edition',
      independently_counts_for_text: false,
      witness_scope: 'version_identity_only',
      same_artifact_as: null,
      document_binding: {
        document_id: 'doc-from', version_label: '2017年版',
        source_artifact_sha256: sha256(fromPdf), version_identity_source_id: 'source:from-identity',
      },
      resource: { resource_id: 'snapshot:from-identity', media_type: 'text/html', sha256: sha256(fromIdentity) },
      canonical_text_sha256: sha256(fromIdentityCanonical),
      spans: [span('online-span:from-identity', '教育部发布旧版课程标准', fromIdentityCanonical, 'version_identity', null)],
      limitations: ['发布页只证明版本身份。'],
    },
    {
      source_id: 'source:to-identity',
      title: '新版官方发布页',
      publisher: '教育部',
      url: 'https://example.gov/to',
      authority_class: 'ministry_official_web',
      evidence_role: 'official_version_identity',
      version_relation: 'exact_document_exact_edition',
      independently_counts_for_text: false,
      witness_scope: 'version_identity_only',
      same_artifact_as: null,
      document_binding: {
        document_id: 'doc-to', version_label: '2017年版2020年修订',
        source_artifact_sha256: sha256(toPdf), version_identity_source_id: 'source:to-identity',
      },
      resource: { resource_id: 'snapshot:to-identity', media_type: 'text/html', sha256: sha256(toIdentity) },
      canonical_text_sha256: sha256(toIdentityCanonical),
      spans: [span('online-span:to-identity', '教育部发布新版修订课程标准', toIdentityCanonical, 'version_identity', null)],
      limitations: ['发布页只证明版本身份。'],
    },
    {
      source_id: 'source:from-independent',
      title: '旧版独立文本',
      publisher: '独立机构',
      url: 'https://independent.example/from',
      authority_class: 'institutional_transcription',
      evidence_role: 'independent_text_transcription',
      version_relation: 'exact_document_exact_edition',
      independently_counts_for_text: true,
      witness_scope: 'exact_document_text',
      same_artifact_as: null,
      document_binding: {
        document_id: 'doc-from', version_label: '2017年版',
        source_artifact_sha256: sha256(fromPdf), version_identity_source_id: 'source:from-identity',
      },
      resource: { resource_id: 'snapshot:from', media_type: 'text/html', sha256: sha256(fromHtml) },
      canonical_text_sha256: sha256(fromCanonical),
      spans: [
        span('online-span:from', '旧版精确表述', fromCanonical, 'exact_text_witness', 'evidence:from'),
      ],
      limitations: ['独立转录不替代原始 PDF。'],
    },
    {
      source_id: 'source:to-independent',
      title: '新版独立文本',
      publisher: '独立机构',
      url: 'https://independent.example/to',
      authority_class: 'institutional_transcription',
      evidence_role: 'independent_text_transcription',
      version_relation: 'exact_document_exact_edition',
      independently_counts_for_text: true,
      witness_scope: 'exact_document_text',
      same_artifact_as: null,
      document_binding: {
        document_id: 'doc-to', version_label: '2017年版2020年修订',
        source_artifact_sha256: sha256(toPdf), version_identity_source_id: 'source:to-identity',
      },
      resource: { resource_id: 'snapshot:to', media_type: 'text/html', sha256: sha256(toHtml) },
      canonical_text_sha256: sha256(toCanonical),
      spans: [span('online-span:to', '新版精确表述', toCanonical, 'exact_text_witness', 'evidence:to')],
      limitations: ['独立转录不替代原始 PDF。'],
    },
    {
      source_id: 'source:to-mirror',
      title: '新版同制品镜像',
      publisher: '镜像机构',
      url: 'https://mirror.example/to.pdf',
      authority_class: 'institutional_mirror',
      evidence_role: 'integrity_only_same_artifact',
      version_relation: 'same_artifact_exact_edition',
      independently_counts_for_text: false,
      witness_scope: 'artifact_integrity_only',
      same_artifact_as: 'source:to-primary',
      document_binding: {
        document_id: 'doc-to', version_label: '2017年版2020年修订',
        source_artifact_sha256: sha256(toPdf), version_identity_source_id: 'source:to-identity',
      },
      resource: { resource_id: 'artifact:to-mirror', media_type: 'application/pdf', sha256: sha256(toPdf) },
      canonical_text_sha256: null,
      spans: [],
      limitations: ['相同 SHA-256，只能核对完整性。'],
    },
  ];

  const evidence = [
    {
      evidence_id: 'evidence:from',
      document_id: 'doc-from',
      paragraph_id: 101,
      paragraph_ordinal: 1,
      physical_pdf_page: 11,
      paragraph_body_sha256: sha256(fromBody),
      utf16_start: fromBody.indexOf('旧版精确表述'),
      utf16_end: fromBody.indexOf('旧版精确表述') + '旧版精确表述'.length,
      exact_text: '旧版精确表述',
      exact_text_sha256: sha256('旧版精确表述'),
      source_artifact_sha256: sha256(fromPdf),
      page_final_text_sha256: fromPageHash,
      page_publication_stable_locator: 'doc-from:page:11',
      page_image: {
        resource_id: 'page-image:from',
        media_type: 'image/png',
        sha256: sha256(fromPageImage),
        rendered_from_source_artifact_sha256: sha256(fromPdf),
        renderer: 'fixture-renderer',
        dpi: 240,
      },
      visual_review: {
        status: 'machine_assisted_visual_match',
        reviewed_by: 'fixture-reviewer',
        reviewed_at: '2026-07-22T00:00:00Z',
        note: '测试页图与精确文字一致。',
      },
      online_witness_span_ids: ['online-span:from'],
      online_conflict_span_ids: [],
    },
    {
      evidence_id: 'evidence:to',
      document_id: 'doc-to',
      paragraph_id: 202,
      paragraph_ordinal: 1,
      physical_pdf_page: 9,
      paragraph_body_sha256: sha256(toBody),
      utf16_start: toBody.indexOf('新版精确表述'),
      utf16_end: toBody.indexOf('新版精确表述') + '新版精确表述'.length,
      exact_text: '新版精确表述',
      exact_text_sha256: sha256('新版精确表述'),
      source_artifact_sha256: sha256(toPdf),
      page_final_text_sha256: toPageHash,
      page_publication_stable_locator: 'doc-to:page:9',
      page_image: {
        resource_id: 'page-image:to',
        media_type: 'image/png',
        sha256: sha256(toPageImage),
        rendered_from_source_artifact_sha256: sha256(toPdf),
        renderer: 'fixture-renderer',
        dpi: 240,
      },
      visual_review: {
        status: 'machine_assisted_visual_match',
        reviewed_by: 'fixture-reviewer',
        reviewed_at: '2026-07-22T00:00:00Z',
        note: '测试页图与精确文字一致。',
      },
      online_witness_span_ids: ['online-span:to'],
      online_conflict_span_ids: [],
    },
  ];
  const assertionSeed = {
    assertion_id: 'assertion:fixture-change',
    assertion_kind: 'exact_textual_revision_observation',
    dimension: '课程理念',
    claim: '旧版与新版在对应位置使用不同的精确表述。',
    from_document_id: 'doc-from',
    to_document_id: 'doc-to',
    from_evidence_ids: ['evidence:from'],
    to_evidence_ids: ['evidence:to'],
    version_identity_source_ids: ['source:from-identity', 'source:to-identity'],
    unresolved_conflict_ids: [],
  };
  const evidenceBundle = {
    assertion_id: assertionSeed.assertion_id,
    assertion_kind: assertionSeed.assertion_kind,
    dimension: assertionSeed.dimension,
    claim: assertionSeed.claim,
    from_document_id: assertionSeed.from_document_id,
    to_document_id: assertionSeed.to_document_id,
    from_evidence: evidence.filter((item) => assertionSeed.from_evidence_ids.includes(item.evidence_id)).map((item) => ({ evidence_id: item.evidence_id, exact_text_sha256: item.exact_text_sha256 })),
    to_evidence: evidence.filter((item) => assertionSeed.to_evidence_ids.includes(item.evidence_id)).map((item) => ({ evidence_id: item.evidence_id, exact_text_sha256: item.exact_text_sha256 })),
    version_identity_source_ids: assertionSeed.version_identity_source_ids,
    unresolved_conflict_ids: assertionSeed.unresolved_conflict_ids,
  };
  const assertion = {
    ...assertionSeed,
    evidence_bundle_sha256: sha256(canonicalJson(evidenceBundle)),
    semantic_statuses: ['exact-source-supported', 'editor-review-pending'],
    review: {
      status: 'pending_signed_editor_review',
      reviewer_id: null,
      decision_resource_id: null,
      uncertainty_note: '精确证据已解析；尚无签名编辑裁决。',
    },
    publication: {
      builder_input_allowed: false,
      public_compare_allowed: false,
      public_star_allowed: false,
      ai_citation_allowed: false,
      discussion_claim_citation_allowed: false,
    },
    release_gate: {
      allowed: false,
      blocked_by_statuses: ['editor-review-pending'],
    },
  };

  const manifest = {
    $schema: './research-evidence-slice.schema.json',
    schema_version: 1,
    policy: 'resolved_exact_span_fail_closed_research_slice_v1',
    slice_id: 'slice:fixture',
    title: '测试纵切片',
    assertion_boundary: '只记录精确文字观察，不主张因果。',
    subject_facet: '语文',
    school_type: 'ordinary_general_education',
    stage: '普通高中',
    corpus: {
      resource_id: 'corpus:sqlite',
      manifest_resource_id: 'corpus:manifest',
      release_id: releaseId,
      release_fingerprint_sha256: corpusManifest.release_fingerprint_sha256,
      manifest_sha256: sha256(corpusManifestRaw),
    },
    documents: [
      {
        role: 'from', document_id: 'doc-from', title: '旧版', version_label: '2017年版',
        sort_year: 2017, issued_by: '教育部', subject: '语文', stage: '普通高中',
        document_type: '课程标准', source_artifact_sha256: sha256(fromPdf),
        primary_source_id: 'source:from-primary', version_identity_source_id: 'source:from-identity',
      },
      {
        role: 'to', document_id: 'doc-to', title: '新版', version_label: '2017年版2020年修订',
        sort_year: 2020, issued_by: '教育部', subject: '语文', stage: '普通高中',
        document_type: '课程标准', source_artifact_sha256: sha256(toPdf),
        primary_source_id: 'source:to-primary', version_identity_source_id: 'source:to-identity',
      },
    ],
    online_sources: sources,
    evidence,
    conflicts: [],
    assertions: [assertion],
    release_boundary: {
      signed_editor_review_required: true,
      builder_input_allowed: false,
      public_data_update_allowed: false,
      deployment_allowed: false,
    },
  };
  const registryDatabase = new DatabaseSync(databasePath, { readOnly: true });
  const sourceRegistry = buildResearchSourceRegistry(manifest, registryDatabase);
  registryDatabase.close();
  const resourcePaths = {
    'corpus:sqlite': databasePath,
    'corpus:manifest': corpusManifestPath,
    'artifact:from': fromPdfPath,
    'artifact:to': toPdfPath,
    'artifact:to-mirror': mirrorPath,
    'snapshot:from': fromHtmlPath,
    'snapshot:to': toHtmlPath,
    'snapshot:from-identity': fromIdentityPath,
    'snapshot:to-identity': toIdentityPath,
    'page-image:from': fromPageImagePath,
    'page-image:to': toPageImagePath,
  };
  const renderPageImage = ({ evidence: item }) => (
    item.evidence_id === 'evidence:from' ? fromPageImage : toPageImage
  );
  return { root, manifest, resourcePaths, sourceRegistry, renderPageImage, fromConflictSpan };
}

function refreshSourceRegistry({ manifest, resourcePaths, sourceRegistry }) {
  const database = new DatabaseSync(resourcePaths['corpus:sqlite'], { readOnly: true });
  const replacement = buildResearchSourceRegistry(manifest, database);
  database.close();
  for (const key of Object.keys(sourceRegistry)) delete sourceRegistry[key];
  Object.assign(sourceRegistry, replacement);
}

test('HTML canonicalization is deterministic and preserves joined Chinese text nodes', () => {
  const html = '<p>全面而有<span>个性的发展</span>奠定基础&nbsp;</p><script>伪证据</script>';
  assert.equal(canonicalizeHtmlText(html), '全面而有个性的发展奠定基础');
});

test('the checked-in JSON Schema rejects root and nested additional properties and missing required fields', async () => {
  const rootExtra = await fixture();
  rootExtra.manifest.unreviewed_extra = true;
  const rootValidation = validateResearchEvidenceSlice(rootExtra);
  assert.ok(rootValidation.errors.some((item) => item.code === 'json_schema_additionalProperties'
    && item.location === '$'));

  const nestedExtra = await fixture();
  nestedExtra.manifest.online_sources[4].document_binding.unreviewed_extra = true;
  const nestedValidation = validateResearchEvidenceSlice(nestedExtra);
  assert.ok(nestedValidation.errors.some((item) => item.code === 'json_schema_additionalProperties'
    && item.location.includes('document_binding')));

  const missingRequired = await fixture();
  delete missingRequired.manifest.online_sources[4].document_binding;
  const requiredValidation = validateResearchEvidenceSlice(missingRequired);
  assert.ok(requiredValidation.errors.some((item) => item.code === 'json_schema_required'));
});

test('resolves corpus, page-publication, artifacts, online bodies and exact UTF-16 spans but stays fail closed pending review', async () => {
  const { manifest, resourcePaths, sourceRegistry, renderPageImage } = await fixture();
  const validation = validateResearchEvidenceSlice({ manifest, resourcePaths, sourceRegistry, renderPageImage });
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.evidence_integrity_valid, true);
  assert.equal(validation.assertions[0].research_evidence_ready, true);
  assert.equal(validation.assertions[0].publication_eligible, false);
  assert.deepEqual(validation.assertions[0].blockers, ['pending_signed_editor_review']);
  assert.deepEqual(validation.assertions[0].semantic_statuses, ['exact-source-supported', 'editor-review-pending']);

  const projection = projectResearchEvidenceSlice({ manifest, validation });
  const expectedReleaseGate = {
    allowed: false,
    blocked_by_statuses: ['editor-review-pending'],
  };
  for (const consumer of ['compare', 'reader_search', 'star', 'ai', 'discussion']) {
    assert.equal(projection.consumer_bindings[consumer][0].assertion_id, 'assertion:fixture-change');
    assert.deepEqual(projection.consumer_bindings[consumer][0].evidence_ids, ['evidence:from', 'evidence:to']);
    assert.deepEqual(projection.consumer_bindings[consumer][0].release_gate, expectedReleaseGate);
    assert.strictEqual(projection.consumer_bindings[consumer][0].release_gate, projection.assertions[0].release_gate);
  }
  assert.equal(projection.consumer_bindings.compare[0].public_display_allowed, false);
  assert.equal(projection.consumer_bindings.reader_search[0].public_display_allowed, false);
  assert.equal(projection.consumer_bindings.star[0].public_display_allowed, false);
  assert.equal(projection.consumer_bindings.ai[0].citation_allowed, false);
  assert.equal(projection.consumer_bindings.discussion[0].claim_citation_allowed, false);
  const result = { validation, projection };
  assert.equal(assertResearchEvidenceReleaseGate(result), result);
  assert.throws(
    () => assertResearchEvidenceReleaseGate(result, { requirePublicationEligible: true }),
    /strict publication eligibility gate failed/,
  );
});

test('the Git-pinned source registry has an exact non-extensible contract', async () => {
  const candidate = await fixture();
  candidate.sourceRegistry.unreviewed_scope = [];
  const validation = validateResearchEvidenceSlice(candidate);
  assert.ok(validation.errors.some((item) => item.code === 'source_registry_invalid'));
  assert.equal(validation.evidence_integrity_valid, false);
});

test('the research corpus rowset digest excludes volatile SQLite audit timestamps', async () => {
  const candidate = await fixture();
  const database = new DatabaseSync(candidate.resourcePaths['corpus:sqlite']);
  database.exec("ALTER TABLE documents ADD COLUMN created_at TEXT; ALTER TABLE documents ADD COLUMN updated_at TEXT;");
  const before = researchCorpusRowsetSha256(database, candidate.manifest);
  database.prepare('UPDATE documents SET created_at=?,updated_at=?').run(
    '2026-07-22 00:00:00',
    '2026-07-22 00:00:01',
  );
  const after = researchCorpusRowsetSha256(database, candidate.manifest);
  database.close();
  assert.equal(before, candidate.sourceRegistry.research_corpus_rowset_sha256);
  assert.equal(after, before);
});

test('fails closed when a corpus paragraph body no longer matches its pinned hash and UTF-16 span', async () => {
  const { manifest, resourcePaths, sourceRegistry, renderPageImage } = await fixture();
  const database = new DatabaseSync(resourcePaths['corpus:sqlite']);
  database.prepare('UPDATE paragraphs SET body=? WHERE id=?').run('tampered body', 101);
  database.close();
  const validation = validateResearchEvidenceSlice({ manifest, resourcePaths, sourceRegistry, renderPageImage });
  assert.equal(validation.evidence_integrity_valid, false);
  assert.match(validation.errors.map((item) => item.code).join(','), /paragraph_body_sha256_mismatch/);
  assert.throws(() => projectResearchEvidenceSlice({ manifest, validation }), /integrity validation failed/);
});

test('fails closed when an online snapshot is missing or its exact span is shifted', async () => {
  const first = await fixture();
  delete first.resourcePaths['snapshot:from'];
  const missing = validateResearchEvidenceSlice(first);
  assert.match(missing.errors.map((item) => item.code).join(','), /resource_missing/);

  const second = await fixture();
  second.manifest.online_sources.find((item) => item.source_id === 'source:from-independent').spans[0].utf16_start += 1;
  const shifted = validateResearchEvidenceSlice(second);
  assert.match(shifted.errors.map((item) => item.code).join(','), /online_span_text_mismatch/);
});

test('same-artifact mirrors never satisfy independent text evidence', async () => {
  const { manifest, resourcePaths, sourceRegistry, renderPageImage } = await fixture();
  manifest.evidence[1].online_witness_span_ids = [];
  manifest.online_sources.find((item) => item.source_id === 'source:to-mirror').independently_counts_for_text = true;
  const validation = validateResearchEvidenceSlice({ manifest, resourcePaths, sourceRegistry, renderPageImage });
  const codes = validation.errors.map((item) => item.code);
  assert.ok(codes.includes('same_artifact_marked_independent'));
  assert.ok(codes.includes('evidence_missing_independent_online_witness'));
});

test('binary bytes labelled as PDF cannot carry arbitrary independent exact-text spans', async () => {
  const { manifest, resourcePaths, sourceRegistry, renderPageImage } = await fixture();
  const source = manifest.online_sources.find(
    (item) => item.source_id === 'source:from-independent',
  );
  source.resource = {
    resource_id: 'page-image:from',
    media_type: 'application/pdf',
    sha256: manifest.evidence[0].page_image.sha256,
  };
  source.canonical_text_sha256 = null;
  const validation = validateResearchEvidenceSlice({ manifest, resourcePaths, sourceRegistry, renderPageImage });
  const codes = validation.errors.map((item) => item.code);
  assert.ok(codes.includes('json_schema_const'));
  assert.ok(codes.includes('independent_text_media_type_invalid'));
  assert.ok(codes.includes('independent_text_body_unverified'));
  assert.equal(validation.assertions[0].research_evidence_ready, false);
  assert.ok(validation.assertions[0].blockers.includes('independent_exact_document_witness_missing'));
});

test('an online witness must bind the exact evidence document, version and artifact', async () => {
  const mismatch = await fixture();
  const source = mismatch.manifest.online_sources.find((item) => item.source_id === 'source:from-independent');
  source.document_binding.document_id = 'doc-to';
  const validation = validateResearchEvidenceSlice(mismatch);
  const codes = validation.errors.map((item) => item.code);
  assert.ok(codes.includes('source_document_binding_version_mismatch'));
  assert.ok(codes.includes('source_document_binding_artifact_mismatch'));
  assert.ok(codes.includes('evidence_online_witness_document_binding_mismatch'));
});

test('a different-edition source cannot satisfy exact-document corroboration', async () => {
  const candidate = await fixture();
  candidate.manifest.online_sources.find(
    (item) => item.source_id === 'source:from-independent',
  ).version_relation = 'different_edition';
  refreshSourceRegistry(candidate);
  const validation = validateResearchEvidenceSlice(candidate);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.assertions[0].research_evidence_ready, false);
  assert.ok(validation.assertions[0].blockers.includes('independent_exact_document_witness_missing'));
});

test('duplicate snapshot bytes and canonical text cannot be relabelled as independent witnesses', async () => {
  const candidate = await fixture();
  const original = candidate.manifest.online_sources.find(
    (item) => item.source_id === 'source:from-independent',
  );
  const relabelled = structuredClone(original);
  relabelled.source_id = 'source:from-independent-relabelled';
  relabelled.title = '改名后的同一快照';
  relabelled.url = 'https://independent.example/relabelled';
  relabelled.resource.resource_id = 'snapshot:from-relabelled';
  relabelled.spans = relabelled.spans.map((span) => ({
    ...span,
    span_id: `${span.span_id}-relabelled`,
  }));
  candidate.manifest.online_sources.push(relabelled);
  candidate.resourcePaths['snapshot:from-relabelled'] = candidate.resourcePaths['snapshot:from'];
  candidate.manifest.evidence[0].online_witness_span_ids = ['online-span:from-relabelled'];
  const validation = validateResearchEvidenceSlice(candidate);
  const codes = validation.errors.map((item) => item.code);
  assert.ok(codes.includes('duplicate_independent_snapshot_bytes'));
  assert.ok(codes.includes('duplicate_independent_canonical_text'));
  assert.ok(validation.assertions[0].blockers.includes('independent_exact_document_witness_missing'));
});

test('a declared unresolved transcription conflict blocks research readiness and every public consumer', async () => {
  const { manifest, resourcePaths, sourceRegistry, renderPageImage, fromConflictSpan } = await fixture();
  manifest.online_sources.find(
    (item) => item.source_id === 'source:from-independent',
  ).spans.push(fromConflictSpan);
  manifest.conflicts.push({
    conflict_id: 'conflict:fixture',
    evidence_id: 'evidence:from',
    source_span_ids: ['online-span:from-conflict'],
    status: 'unresolved_fail_closed',
    note: '在线转录与原始页文字不一致。',
  });
  manifest.evidence[0].online_conflict_span_ids = ['online-span:from-conflict'];
  manifest.assertions[0].unresolved_conflict_ids = ['conflict:fixture'];
  manifest.assertions[0].semantic_statuses = [
    'exact-source-supported',
    'online-version-conflict',
    'editor-review-pending',
  ];
  manifest.assertions[0].release_gate.blocked_by_statuses = [
    'online-version-conflict',
    'editor-review-pending',
  ];
  const evidenceById = new Map(manifest.evidence.map((item) => [item.evidence_id, item]));
  const assertion = manifest.assertions[0];
  assertion.evidence_bundle_sha256 = sha256(canonicalJson({
    assertion_id: assertion.assertion_id,
    assertion_kind: assertion.assertion_kind,
    dimension: assertion.dimension,
    claim: assertion.claim,
    from_document_id: assertion.from_document_id,
    to_document_id: assertion.to_document_id,
    from_evidence: assertion.from_evidence_ids.map((id) => ({ evidence_id: id, exact_text_sha256: evidenceById.get(id).exact_text_sha256 })),
    to_evidence: assertion.to_evidence_ids.map((id) => ({ evidence_id: id, exact_text_sha256: evidenceById.get(id).exact_text_sha256 })),
    version_identity_source_ids: assertion.version_identity_source_ids,
    unresolved_conflict_ids: assertion.unresolved_conflict_ids,
  }));
  refreshSourceRegistry({ manifest, resourcePaths, sourceRegistry });
  const validation = validateResearchEvidenceSlice({ manifest, resourcePaths, sourceRegistry, renderPageImage });
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.assertions[0].research_evidence_ready, false);
  assert.deepEqual(validation.assertions[0].semantic_statuses, [
    'exact-source-supported',
    'online-version-conflict',
    'editor-review-pending',
  ]);
  assert.deepEqual(validation.assertions[0].blockers, ['unresolved_transcription_conflict', 'pending_signed_editor_review']);
  const projection = projectResearchEvidenceSlice({ manifest, validation });
  const expectedReleaseGate = {
    allowed: false,
    blocked_by_statuses: ['online-version-conflict', 'editor-review-pending'],
  };
  for (const consumer of ['compare', 'reader_search', 'star', 'ai', 'discussion']) {
    assert.deepEqual(projection.consumer_bindings[consumer][0].release_gate, expectedReleaseGate);
  }
});

test('assertion conflict statuses and gate blockers are derived from every conflict touching its evidence', async () => {
  const { manifest, resourcePaths, sourceRegistry, renderPageImage, fromConflictSpan } = await fixture();
  manifest.online_sources.find(
    (item) => item.source_id === 'source:from-independent',
  ).spans.push(fromConflictSpan);
  manifest.conflicts.push({
    conflict_id: 'conflict:fixture-omitted',
    evidence_id: 'evidence:from',
    source_span_ids: ['online-span:from-conflict'],
    status: 'unresolved_fail_closed',
    note: '攻击样例保留冲突对象，却从断言自报字段删除冲突。',
  });
  manifest.evidence[0].online_conflict_span_ids = ['online-span:from-conflict'];
  const validation = validateResearchEvidenceSlice({ manifest, resourcePaths, sourceRegistry, renderPageImage });
  const codes = validation.errors.map((item) => item.code);
  assert.ok(codes.includes('assertion_required_conflicts_mismatch'));
  assert.ok(codes.includes('assertion_bundle_sha256_mismatch'));
  assert.ok(codes.includes('assertion_semantic_statuses_mismatch'));
  assert.ok(codes.includes('assertion_release_gate_blockers_mismatch'));
  assert.ok(validation.assertions[0].blockers.includes('unresolved_transcription_conflict'));
});

test('an evidence-declared conflict span cannot lose its conflict record', async () => {
  const { manifest, resourcePaths, sourceRegistry, renderPageImage, fromConflictSpan } = await fixture();
  manifest.online_sources.find(
    (item) => item.source_id === 'source:from-independent',
  ).spans.push(fromConflictSpan);
  manifest.evidence[0].online_conflict_span_ids = ['online-span:from-conflict'];
  const validation = validateResearchEvidenceSlice({ manifest, resourcePaths, sourceRegistry, renderPageImage });
  assert.ok(validation.errors.some((item) => item.code === 'evidence_conflict_span_coverage_invalid'));
});

test('a transcription-conflict span cannot be orphaned by deleting every conflict declaration', async () => {
  const { manifest, resourcePaths, sourceRegistry, renderPageImage, fromConflictSpan } = await fixture();
  manifest.online_sources.find(
    (item) => item.source_id === 'source:from-independent',
  ).spans.push(fromConflictSpan);
  const validation = validateResearchEvidenceSlice({ manifest, resourcePaths, sourceRegistry, renderPageImage });
  assert.ok(validation.errors.some(
    (item) => item.code === 'transcription_conflict_span_coverage_invalid',
  ));
});

test('a transcription-conflict span cannot be claimed by duplicate conflict records', async () => {
  const { manifest, resourcePaths, sourceRegistry, renderPageImage, fromConflictSpan } = await fixture();
  manifest.online_sources.find(
    (item) => item.source_id === 'source:from-independent',
  ).spans.push(fromConflictSpan);
  manifest.evidence[0].online_conflict_span_ids = ['online-span:from-conflict'];
  manifest.conflicts.push(
    {
      conflict_id: 'conflict:fixture-first',
      evidence_id: 'evidence:from',
      source_span_ids: ['online-span:from-conflict'],
      status: 'unresolved_fail_closed',
      note: '第一条重复冲突声明。',
    },
    {
      conflict_id: 'conflict:fixture-second',
      evidence_id: 'evidence:from',
      source_span_ids: ['online-span:from-conflict'],
      status: 'unresolved_fail_closed',
      note: '第二条重复冲突声明。',
    },
  );
  const validation = validateResearchEvidenceSlice({ manifest, resourcePaths, sourceRegistry, renderPageImage });
  const codes = validation.errors.map((item) => item.code);
  assert.ok(codes.includes('evidence_conflict_span_coverage_invalid'));
  assert.ok(codes.includes('transcription_conflict_span_coverage_invalid'));
});

test('rejects the shared five-consumer release gate when it opens before editor review', async () => {
  const { manifest, resourcePaths, sourceRegistry, renderPageImage } = await fixture();
  manifest.assertions[0].release_gate.allowed = true;
  const validation = validateResearchEvidenceSlice({ manifest, resourcePaths, sourceRegistry, renderPageImage });
  assert.equal(validation.evidence_integrity_valid, false);
  assert.ok(validation.errors.some((item) => item.code === 'assertion_release_gate_open'));
  assert.throws(() => projectResearchEvidenceSlice({ manifest, validation }), /integrity validation failed/);
});

test('rejects PDF or binary bytes self-labelled as an independent HTML transcription', async () => {
  const candidate = await fixture();
  const source = candidate.manifest.online_sources.find((item) => item.source_id === 'source:from-independent');
  const raw = Buffer.from('%PDF-1.7\nnot really HTML\n旧版精确表述\n%%EOF');
  await writeFile(candidate.resourcePaths['snapshot:from'], raw);
  const canonical = canonicalizeHtmlText(raw.toString('utf8'));
  source.resource.sha256 = sha256(raw);
  source.canonical_text_sha256 = sha256(canonical);
  source.spans[0].utf16_start = canonical.indexOf('旧版精确表述');
  source.spans[0].utf16_end = source.spans[0].utf16_start + '旧版精确表述'.length;
  const validation = validateResearchEvidenceSlice(candidate);
  assert.ok(validation.errors.some((item) => item.code === 'html_resource_structure_invalid'));
  assert.equal(validation.evidence_integrity_valid, false);
});

test('rejects an unrelated HTML page self-labelled as the official exact work and edition identity', async () => {
  const candidate = await fixture();
  const source = candidate.manifest.online_sources.find((item) => item.source_id === 'source:from-identity');
  const raw = Buffer.from('<html><body><p>完全无关的网页内容</p></body></html>');
  await writeFile(candidate.resourcePaths['snapshot:from-identity'], raw);
  const canonical = canonicalizeHtmlText(raw.toString('utf8'));
  source.resource.sha256 = sha256(raw);
  source.canonical_text_sha256 = sha256(canonical);
  source.spans[0] = {
    ...source.spans[0], utf16_start: 0, utf16_end: canonical.length,
    exact_text: canonical, exact_text_sha256: sha256(canonical), occurrence_index: 0,
  };
  const validation = validateResearchEvidenceSlice(candidate);
  assert.ok(validation.errors.some((item) => item.code === 'source_contract_registry_mismatch'));
  assert.equal(validation.evidence_integrity_valid, false);
});

test('rejects non-PNG bytes and any page image not reproduced from the fixed PDF page', async () => {
  const candidate = await fixture();
  const raw = Buffer.from('not a PNG and not rendered from the PDF');
  await writeFile(candidate.resourcePaths['page-image:from'], raw);
  candidate.manifest.evidence[0].page_image.sha256 = sha256(raw);
  const validation = validateResearchEvidenceSlice(candidate);
  const codes = validation.errors.map((item) => item.code);
  assert.ok(codes.includes('evidence_page_image_magic_invalid'));
  assert.ok(codes.includes('evidence_page_render_mismatch'));
});

test('rejects a forged owner SQLite even when its research manifest and internal row hashes are made self-consistent', async () => {
  const candidate = await fixture();
  const forgedText = '伪造精确表述';
  const forgedBody = `段落前${forgedText}段落后`;
  const forgedPageHash = sha256('forged-page');
  const database = new DatabaseSync(candidate.resourcePaths['corpus:sqlite']);
  database.prepare('UPDATE paragraphs SET body=?,body_sha256=?,page_final_text_sha256=? WHERE id=?')
    .run(forgedBody, sha256(forgedBody), forgedPageHash, 101);
  database.prepare('UPDATE page_publication_gates SET final_text_sha256=? WHERE document_id=? AND page_number=?')
    .run(forgedPageHash, 'doc-from', 11);
  database.close();
  const evidence = candidate.manifest.evidence[0];
  evidence.paragraph_body_sha256 = sha256(forgedBody);
  evidence.utf16_start = forgedBody.indexOf(forgedText);
  evidence.utf16_end = evidence.utf16_start + forgedText.length;
  evidence.exact_text = forgedText;
  evidence.exact_text_sha256 = sha256(forgedText);
  evidence.page_final_text_sha256 = forgedPageHash;
  const source = candidate.manifest.online_sources.find((item) => item.source_id === 'source:from-independent');
  const raw = Buffer.from(`<html><body><p>${forgedText}</p></body></html>`);
  await writeFile(candidate.resourcePaths['snapshot:from'], raw);
  const canonical = canonicalizeHtmlText(raw.toString('utf8'));
  source.resource.sha256 = sha256(raw);
  source.canonical_text_sha256 = sha256(canonical);
  source.spans[0] = {
    ...source.spans[0], utf16_start: 0, utf16_end: forgedText.length,
    exact_text: forgedText, exact_text_sha256: sha256(forgedText), occurrence_index: 0,
  };
  const assertion = candidate.manifest.assertions[0];
  const evidenceById = new Map(candidate.manifest.evidence.map((item) => [item.evidence_id, item]));
  assertion.evidence_bundle_sha256 = sha256(canonicalJson({
    assertion_id: assertion.assertion_id, assertion_kind: assertion.assertion_kind,
    dimension: assertion.dimension, claim: assertion.claim,
    from_document_id: assertion.from_document_id, to_document_id: assertion.to_document_id,
    from_evidence: assertion.from_evidence_ids.map((id) => ({ evidence_id: id, exact_text_sha256: evidenceById.get(id).exact_text_sha256 })),
    to_evidence: assertion.to_evidence_ids.map((id) => ({ evidence_id: id, exact_text_sha256: evidenceById.get(id).exact_text_sha256 })),
    version_identity_source_ids: assertion.version_identity_source_ids,
    unresolved_conflict_ids: assertion.unresolved_conflict_ids,
  }));
  const validation = validateResearchEvidenceSlice(candidate);
  assert.ok(validation.errors.some((item) => item.code === 'corpus_research_rowset_registry_mismatch'));
  assert.equal(validation.evidence_integrity_valid, false);
});

test('rejects fragment aliases and source-scope expansion for the same HTTP retrieval', async () => {
  const candidate = await fixture();
  const original = candidate.manifest.online_sources.find((item) => item.source_id === 'source:from-independent');
  const relabelled = structuredClone(original);
  relabelled.source_id = 'source:from-independent-fragment';
  relabelled.url = `${original.url}#same-http-retrieval`;
  relabelled.resource.resource_id = 'snapshot:from-fragment';
  relabelled.spans[0].span_id = 'online-span:from-fragment';
  const aliasPath = path.join(candidate.root, 'fragment-alias.html');
  await writeFile(aliasPath, await import('node:fs/promises').then(({ readFile }) => readFile(candidate.resourcePaths['snapshot:from'])));
  candidate.resourcePaths[relabelled.resource.resource_id] = aliasPath;
  candidate.manifest.online_sources.push(relabelled);
  candidate.manifest.evidence[0].online_witness_span_ids = [relabelled.spans[0].span_id];
  const validation = validateResearchEvidenceSlice(candidate);
  const codes = validation.errors.map((item) => item.code);
  assert.ok(codes.includes('source_url_invalid'));
  assert.ok(codes.includes('source_registry_source_scope_mismatch'));
});

test('rejects semantic aliases of one conflict span even when each alias has one conflict id', async () => {
  const candidate = await fixture();
  const source = candidate.manifest.online_sources.find((item) => item.source_id === 'source:from-independent');
  source.spans.push(candidate.fromConflictSpan, {
    ...structuredClone(candidate.fromConflictSpan), span_id: 'online-span:from-conflict-alias',
  });
  candidate.manifest.evidence[0].online_conflict_span_ids = [
    'online-span:from-conflict', 'online-span:from-conflict-alias',
  ];
  candidate.manifest.conflicts.push(
    { conflict_id: 'conflict:alias', evidence_id: 'evidence:from', source_span_ids: ['online-span:from-conflict-alias'], status: 'unresolved_fail_closed', note: '语义别名。' },
    { conflict_id: 'conflict:primary', evidence_id: 'evidence:from', source_span_ids: ['online-span:from-conflict'], status: 'unresolved_fail_closed', note: '原始区间。' },
  );
  const validation = validateResearchEvidenceSlice(candidate);
  assert.ok(validation.errors.some((item) => item.code === 'duplicate_semantic_online_span'));
});

test('rejects hiding a known mismatch by renaming its purpose from conflict to witness', async () => {
  const candidate = await fixture();
  const source = candidate.manifest.online_sources.find((item) => item.source_id === 'source:from-independent');
  source.spans.push({ ...candidate.fromConflictSpan, purpose: 'exact_text_witness' });
  const validation = validateResearchEvidenceSlice(candidate);
  const codes = validation.errors.map((item) => item.code);
  assert.ok(codes.includes('source_contract_registry_mismatch'));
  assert.ok(codes.includes('exact_text_witness_coverage_invalid'));
  assert.ok(codes.includes('exact_text_witness_bound_text_mismatch'));
});
