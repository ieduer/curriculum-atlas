import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  loadOntologyReleaseContext,
  makeJsonArtifact,
  validateOntologyRelease,
} from '../scripts/validate-ontology-release.mjs';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('data/ontology-release-manifest.json', root), 'utf8'));
const context = await loadOntologyReleaseContext(new URL('.', root).pathname);
const text = (report) => report.errors.join('\n');
const copy = (value) => structuredClone(value);
const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const PARAGRAPH = '核心素养是课程育人价值的集中体现，并统领课程目标与课程内容。';
const NODE_LABEL = '核心素养';
const NODE_DEFINITION = '课程育人价值的集中体现';
const SHA = Object.freeze({
  page: '1'.repeat(64),
  bundle: '3'.repeat(64),
  coverage: '5'.repeat(64),
});

function withArtifact(baseContext, key, json) {
  const artifact = makeJsonArtifact(baseContext.artifacts[key].path, json);
  return {
    context: {
      ...baseContext,
      artifacts: { ...baseContext.artifacts, [key]: artifact },
    },
    artifact,
  };
}

function acceptedPageFixture(pageNumber = 11, paragraph = PARAGRAPH) {
  const pages = Array.from({ length: 109 }, (_, index) => {
    const number = index + 1;
    const accepted = number === pageNumber;
    return {
      page_number: number,
      source_page_sha256: accepted ? SHA.page : digest(`source-page-${number}`),
      final_text_sha256: accepted ? digest(paragraph) : digest(`unreleased-page-${number}`),
      evidence_bundle_sha256: accepted ? SHA.bundle : digest(`evidence-bundle-${number}`),
      stable_locator: `moe-2022-03:page:${number}`,
      review_status: accepted ? 'accepted' : 'unresolved_fail_closed',
      display_allowed: accepted,
      citation_allowed: accepted,
      uncertainty_note: accepted ? null : 'synthetic page remains fail closed',
    };
  });
  return {
    manifest: {
    $schema: './page-publication-manifest.schema.json',
    schema_version: 1,
    policy: 'fail_closed_page_publication_v1',
    documents: [{
      document_id: 'moe-2022-03',
      source_artifact_sha256: manifest.input_fingerprints.source_artifact_sha256,
      acceptance_status: 'accepted_page_manifest',
      reviewed_by: 'reviewer:test-page',
      reviewed_at: '2026-07-18T00:00:00Z',
      pages,
    }],
    },
    paragraph: {
      document_id: 'moe-2022-03',
      ordinal: 1,
      physical_page: pageNumber,
      body: paragraph,
      body_sha256: digest(paragraph),
      source_artifact_sha256: manifest.input_fingerprints.source_artifact_sha256,
      source_page_sha256: SHA.page,
      final_text_sha256: digest(paragraph),
      evidence_bundle_sha256: SHA.bundle,
      display_allowed: true,
      citation_allowed: true,
    },
  };
}

function reviewedFixture(pageNumber = 11, paragraph = PARAGRAPH) {
  const release = copy(manifest);
  const pageFixture = acceptedPageFixture(pageNumber, paragraph);
  const pageReplacement = withArtifact(context, 'page_publication', pageFixture.manifest);
  const catalog = copy(pageReplacement.context.artifacts.catalog.json);
  catalog.documents.find((record) => record.id === 'moe-2022-03').citation_allowed = true;
  const catalogReplacement = withArtifact(pageReplacement.context, 'catalog', catalog);
  release.input_fingerprints.page_publication.sha256 = pageReplacement.artifact.sha256;
  release.input_fingerprints.catalog.sha256 = catalogReplacement.artifact.sha256;
  release.publication_state = 'reviewed_release';
  release.builder_input_allowed = true;
  release.public_data_update_allowed = true;
  release.assertions = [{
    assertion_id: 'assertion:zh-compulsory-2022-core-competencies-p011',
    scope_id: 'scope:zh-compulsory-2022-ordinary',
    assertion_type: 'official_structure',
    document_id: 'moe-2022-03',
    edition_id: 'edition:moe-2022-03',
    physical_page: pageNumber,
    paragraph_ordinal: 1,
    start_offset: 0,
    end_offset: paragraph.length,
    candidate_anchor_id: 'anchor:zh-compulsory-2022-core-competency-p011-p012',
    paragraph_body_sha256: digest(paragraph),
    source_page_sha256: SHA.page,
    final_text_sha256: digest(paragraph),
    evidence_bundle_sha256: SHA.bundle,
    asserted_text_sha256: digest(paragraph),
    node_binding: {
      node_id: 'ontology:zh-compulsory-2022-core-competencies',
      candidate_node_id: 'candidate:zh-compulsory-2022-core-competency',
      node_type: 'competency_framework',
      label_start_offset: paragraph.indexOf(NODE_LABEL),
      label_end_offset: paragraph.indexOf(NODE_LABEL) + NODE_LABEL.length,
      definition_start_offset: paragraph.indexOf(NODE_DEFINITION),
      definition_end_offset: paragraph.indexOf(NODE_DEFINITION) + NODE_DEFINITION.length,
    },
    online_claim_ids: ['claim:core-competencies'],
    independent_online_source_ids: [
      'source:moe-2022-qa',
      'source:jyb-video-20220720',
    ],
    version_relation: 'exact_document_exact_edition',
    adjudication: 'accepted',
    uncertainty_note: null,
    reviewer: {
      reviewer_id: 'reviewer:test-assertion',
      reviewed_at: '2026-07-18T00:01:00Z',
      method: 'manual_source_image_review',
    },
    citation_allowed: true,
  }];
  release.nodes = [{
    id: 'ontology:zh-compulsory-2022-core-competencies',
    candidate_node_id: 'candidate:zh-compulsory-2022-core-competency',
    scope_id: 'scope:zh-compulsory-2022-ordinary',
    node_type: 'competency_framework',
    label: '核心素养',
    label_kind: 'official_term',
    normative_role: 'official_curriculum_structure',
    parent_id: null,
    lexical_concept_id: 'core-competency',
    definition: NODE_DEFINITION,
    field_binding_assertion_id: 'assertion:zh-compulsory-2022-core-competencies-p011',
    source_assertion_ids: ['assertion:zh-compulsory-2022-core-competencies-p011'],
    review_status: 'editor_reviewed',
    citation_allowed: true,
  }];
  release.relations = [];
  release.release_gate = {
    release_authorized: true,
    candidate_nodes_promoted: 1,
    accepted_leaf_nodes: 1,
    source_controls_resolved: true,
    complete_historical_coverage: false,
    negative_historical_assertions_allowed: false,
    reviewed_by: 'reviewer:test-release',
    reviewed_at: '2026-07-18T00:02:00Z',
    reason_codes: ['manual_release_review_complete'],
  };
  return {
    release,
    context: {
      ...catalogReplacement.context,
      canonical_paragraphs: new Map([[
        `moe-2022-03\u00001`,
        pageFixture.paragraph,
      ]]),
    },
  };
}

function addLanguageUseChild(fixture) {
  const paragraph = fixture.context.canonical_paragraphs.get('moe-2022-03\u00001').body;
  const label = '语言运用';
  const definition = '通过语言实践落实';
  assert.ok(paragraph.includes(label) && paragraph.includes(definition));
  const assertion = copy(fixture.release.assertions[0]);
  assertion.assertion_id = 'assertion:zh-compulsory-2022-language-use-p011';
  assertion.assertion_type = 'student_ability';
  assertion.node_binding = {
    node_id: 'ontology:zh-compulsory-2022-language-use',
    candidate_node_id: 'candidate:zh-compulsory-2022-language-use',
    node_type: 'core_competency_dimension',
    label_start_offset: paragraph.indexOf(label),
    label_end_offset: paragraph.indexOf(label) + label.length,
    definition_start_offset: paragraph.indexOf(definition),
    definition_end_offset: paragraph.indexOf(definition) + definition.length,
  };
  fixture.release.assertions.push(assertion);
  fixture.release.nodes.push({
    id: 'ontology:zh-compulsory-2022-language-use',
    candidate_node_id: 'candidate:zh-compulsory-2022-language-use',
    scope_id: 'scope:zh-compulsory-2022-ordinary',
    node_type: 'core_competency_dimension',
    label,
    label_kind: 'official_term',
    normative_role: 'official_core_competency_dimension',
    parent_id: 'ontology:zh-compulsory-2022-core-competencies',
    lexical_concept_id: 'language-use',
    definition,
    field_binding_assertion_id: assertion.assertion_id,
    source_assertion_ids: [assertion.assertion_id],
    review_status: 'editor_reviewed',
    citation_allowed: true,
  });
  fixture.release.release_gate.candidate_nodes_promoted = 2;
  fixture.release.release_gate.accepted_leaf_nodes = 1;
  return fixture;
}

test('canonical bridge is schema-valid, empty, fail-closed and preserves 169 public ontology nodes', () => {
  const report = validateOntologyRelease(manifest, context);
  assert.equal(report.valid, true, text(report));
  assert.equal(report.publishable, false);
  assert.equal(report.publication_state, 'empty_fail_closed');
  assert.deepEqual(report.counts, {
    scopes: 1,
    assertions: 0,
    nodes: 0,
    leaves: 0,
    accepted_leaves: 0,
    relations: 0,
    public_ontology_nodes: 169,
  });
  assert.equal(report.builder_isolated, true);
});

test('all 12 facets expose honest not_started/candidate/released coverage', () => {
  const rows = new Map(manifest.facet_coverage.map((row) => [row.subject_facet, row]));
  assert.equal(rows.size, 12);
  assert.deepEqual(rows.get('语文'), {
    subject_facet: '语文',
    status: 'released',
    released_scope_count: 3,
    released_node_count: 169,
    candidate_scope_count: 1,
    candidate_node_count: 64,
  });
  for (const facet of [
    '数学', '外语', '思想政治与道德法治', '历史', '历史与社会', '地理',
    '科学类', '技术', '劳动', '艺术', '体育与健康',
  ]) {
    assert.deepEqual(rows.get(facet), {
      subject_facet: facet,
      status: 'not_started',
      released_scope_count: 0,
      released_node_count: 0,
      candidate_scope_count: 0,
      candidate_node_count: 0,
    });
  }
});

test('a synthetic fully reviewed positive assertion passes the bridge without changing public data', () => {
  const fixture = reviewedFixture();
  const report = validateOntologyRelease(fixture.release, fixture.context);
  assert.equal(report.valid, true, text(report));
  assert.equal(report.publishable, true);
  assert.equal(report.counts.accepted_leaves, 1);
  assert.equal(report.counts.public_ontology_nodes, 169);
});

test('every node field and candidate anchor is bound to the accepted canonical substring', async (t) => {
  const cases = [
    ['asserted substring hash', (fixture) => {
      fixture.release.assertions[0].asserted_text_sha256 = '0'.repeat(64);
    }, /asserted_text_hash_mismatch/],
    ['paragraph ordinal', (fixture) => {
      fixture.release.assertions[0].paragraph_ordinal = 2;
    }, /canonical_paragraph_missing/],
    ['candidate node provenance', (fixture) => {
      fixture.release.nodes[0].candidate_node_id = 'candidate:missing-node';
      fixture.release.assertions[0].node_binding.candidate_node_id = 'candidate:missing-node';
    }, /candidate_node_missing/],
    ['candidate anchor provenance', (fixture) => {
      fixture.release.assertions[0].candidate_anchor_id = 'anchor:zh-compulsory-2022-toc-p006';
    }, /candidate_anchor_not_bound_to_node|candidate_anchor_page_mismatch/],
    ['node label', (fixture) => {
      fixture.release.nodes[0].label = '伪造核心素养';
    }, /candidate_label_drift|node_label_not_in_canonical_text/],
    ['node definition', (fixture) => {
      fixture.release.nodes[0].definition = '未出现在课标正文中的定义';
    }, /node_definition_not_in_canonical_text/],
    ['node type', (fixture) => {
      fixture.release.nodes[0].node_type = 'quality_framework';
    }, /node_type_binding_mismatch/],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, () => {
      const fixture = reviewedFixture();
      mutate(fixture);
      const report = validateOntologyRelease(fixture.release, fixture.context);
      assert.equal(report.valid, false);
      assert.match(text(report), expected);
    });
  }
});

test('internal nodes are held to the same accepted provenance gate as leaves', () => {
  const body = '核心素养是课程育人价值的集中体现，语言运用通过语言实践落实课程目标与课程内容。';
  const fixture = addLanguageUseChild(reviewedFixture(11, body));
  const valid = validateOntologyRelease(fixture.release, fixture.context);
  assert.equal(valid.valid, true, text(valid));
  assert.equal(valid.publishable, true);
  assert.equal(valid.counts.nodes, 2);
  assert.equal(valid.counts.leaves, 1);

  fixture.release.nodes[0].field_binding_assertion_id = fixture.release.nodes[1].field_binding_assertion_id;
  const report = validateOntologyRelease(fixture.release, fixture.context);
  assert.equal(report.valid, false);
  assert.match(text(report), /node_binding_id_mismatch|node_without_accepted_provenance/);
});

test('relations require exact content-level endpoint and statement evidence', () => {
  const body = '核心素养是课程育人价值的集中体现，语言运用通过语言实践落实课程目标与课程内容。';
  const fixture = addLanguageUseChild(reviewedFixture(11, body));
  const basis = '核心素养通过语言运用落实';
  fixture.release.relations = [{
    id: 'relation:zh-compulsory-2022-core-to-language-use',
    relation_type: 'supports',
    source: fixture.release.nodes[0].id,
    target: fixture.release.nodes[1].id,
    scope_ids: [fixture.release.scopes[0].scope_id],
    assertion_basis: basis,
    assertion_basis_sha256: digest(basis),
    evidence_assertion_ids: fixture.release.assertions.map((assertion) => assertion.assertion_id),
    content_bindings: [{
      assertion_id: fixture.release.assertions[0].assertion_id,
      evidence_role: 'source_endpoint',
      text_start_offset: 0,
      text_end_offset: body.length,
      text_sha256: digest(body),
    }, {
      assertion_id: fixture.release.assertions[1].assertion_id,
      evidence_role: 'target_endpoint',
      text_start_offset: 0,
      text_end_offset: body.length,
      text_sha256: digest(body),
    }, {
      assertion_id: fixture.release.assertions[0].assertion_id,
      evidence_role: 'relation_statement',
      text_start_offset: 0,
      text_end_offset: body.length,
      text_sha256: digest(body),
    }],
    review_status: 'editor_reviewed',
    reviewer: {
      reviewer_id: 'reviewer:test-relation',
      reviewed_at: '2026-07-18T00:03:00Z',
      method: 'manual_source_image_review',
    },
    semantic_relation_allowed: true,
  }];
  const valid = validateOntologyRelease(fixture.release, fixture.context);
  assert.equal(valid.valid, true, text(valid));

  fixture.release.relations[0].content_bindings[1].text_sha256 = '0'.repeat(64);
  const report = validateOntologyRelease(fixture.release, fixture.context);
  assert.equal(report.valid, false);
  assert.match(text(report), /relation_content_hash_mismatch/);
});

test('input fingerprints bind candidate, page publication, online verification and graph artifacts', async (t) => {
  for (const key of [
    'candidate', 'page_publication', 'online_verification',
    'catalog', 'semantic_publication',
    'formal_ontology', 'public_core', 'public_academic',
  ]) {
    await t.test(key, () => {
      const changed = copy(manifest);
      changed.input_fingerprints[key].sha256 = '0'.repeat(64);
      const report = validateOntologyRelease(changed, context);
      assert.equal(report.valid, false);
      assert.match(text(report), /fingerprint_sha256_mismatch/);
    });
  }
});

test('coordinated public graph and self-reported manifest mutation cannot move the reviewed baseline', () => {
  const changed = copy(manifest);
  let changedContext = context;
  for (const key of ['formal_ontology', 'public_core', 'public_academic']) {
    const json = copy(changedContext.artifacts[key].json);
    json.coordinated_mutation = `synthetic-${key}`;
    const replacement = withArtifact(changedContext, key, json);
    changedContext = replacement.context;
    changed.input_fingerprints[key].sha256 = replacement.artifact.sha256;
  }
  const report = validateOntologyRelease(changed, changedContext);
  assert.equal(report.valid, false);
  assert.match(text(report), /public_graph_baseline_hash_mismatch|public_graph_baseline_declaration_mismatch/);
  assert.equal(report.counts.public_ontology_nodes, 169);
});

test('scope lock rejects subject, stage, school type, edition and source hash drift', async (t) => {
  const cases = [
    ['subject_facet', '数学', /scope_subject_mismatch/],
    ['stage', '高中', /scope_stage_mismatch/],
    ['school_type', 'special_education_school_for_the_blind', /scope_school_type_mismatch/],
    ['edition_id', 'edition:moe-hs-2020-02', /scope_edition_mismatch/],
    ['source_artifact_sha256', '0'.repeat(64), /scope_source_hash_mismatch/],
  ];
  for (const [key, value, expected] of cases) {
    await t.test(key, () => {
      const changed = copy(manifest);
      changed.scopes[0][key] = value;
      const report = validateOntologyRelease(changed, context);
      assert.equal(report.valid, false);
      assert.match(text(report), expected);
    });
  }
});

test('additional fields are rejected at top-level and nested assertion levels', () => {
  const top = copy(manifest);
  top.unreviewed_escape_hatch = true;
  assert.match(text(validateOntologyRelease(top, context)), /additional property is forbidden/);

  const fixture = reviewedFixture();
  fixture.release.assertions[0].page_guess = 11;
  assert.match(text(validateOntologyRelease(fixture.release, fixture.context)), /additional property is forbidden/);
});

test('unaccepted page, unresolved assertion and blocked physical page are rejected', async (t) => {
  await t.test('page review is not accepted', () => {
    const fixture = reviewedFixture();
    const pageJson = copy(fixture.context.artifacts.page_publication.json);
    const page = pageJson.documents[0].pages.find((entry) => entry.page_number === 11);
    page.review_status = 'unresolved_fail_closed';
    page.display_allowed = false;
    page.citation_allowed = false;
    page.uncertainty_note = 'synthetic unresolved page';
    const replacement = withArtifact(fixture.context, 'page_publication', pageJson);
    fixture.release.input_fingerprints.page_publication.sha256 = replacement.artifact.sha256;
    const report = validateOntologyRelease(fixture.release, replacement.context);
    assert.equal(report.valid, false);
    assert.match(text(report), /page_not_accepted/);
  });

  await t.test('assertion adjudication is unresolved', () => {
    const fixture = reviewedFixture();
    fixture.release.assertions[0].adjudication = 'unresolved';
    fixture.release.assertions[0].citation_allowed = false;
    fixture.release.assertions[0].uncertainty_note = 'OCR 行序仍待人工裁决';
    const report = validateOntologyRelease(fixture.release, fixture.context);
    assert.equal(report.valid, false);
    assert.match(text(report), /unresolved_assertion|leaf_without_accepted_assertion/);
  });

  await t.test('preemptively blocked page 75', () => {
    const fixture = reviewedFixture(75);
    const report = validateOntologyRelease(fixture.release, fixture.context);
    assert.equal(report.valid, false);
    assert.match(text(report), /blocked_page_reference/);
  });
});

test('byte-identical mirror and version-mismatched sources never count as independent evidence', async (t) => {
  await t.test('same artifact mirror', () => {
    const fixture = reviewedFixture();
    fixture.release.assertions[0].independent_online_source_ids = [
      'source:moe-2022-qa',
      'source:ictr-2022-chinese-pdf',
    ];
    const report = validateOntologyRelease(fixture.release, fixture.context);
    assert.equal(report.valid, false);
    assert.match(text(report), /online_source_not_independent|insufficient_independent_online_evidence/);
  });

  await t.test('wrong edition source', () => {
    const fixture = reviewedFixture();
    fixture.release.assertions[0].independent_online_source_ids = [
      'source:moe-2022-qa',
      'source:hep-2025-revision',
    ];
    const report = validateOntologyRelease(fixture.release, fixture.context);
    assert.equal(report.valid, false);
    assert.match(text(report), /version_mismatch_source_used|online_source_not_independent/);
  });

  await t.test('partial conflicted online claim', () => {
    const fixture = reviewedFixture();
    fixture.release.assertions[0].online_claim_ids = ['claim:overall-goals'];
    fixture.release.assertions[0].independent_online_source_ids = [
      'source:pep-goal6-2024-06',
      'source:moe-2022-qa',
    ];
    const report = validateOntologyRelease(fixture.release, fixture.context);
    assert.equal(report.valid, false);
    assert.match(text(report), /online_claim_unresolved/);
  });
});

test('dangling parent, cross-scope parent and cycles are rejected', async (t) => {
  await t.test('dangling parent', () => {
    const fixture = reviewedFixture();
    fixture.release.nodes[0].parent_id = 'ontology:missing-parent';
    assert.match(text(validateOntologyRelease(fixture.release, fixture.context)), /dangling_parent/);
  });

  await t.test('cross-scope parent', () => {
    const fixture = reviewedFixture();
    const secondScope = copy(fixture.release.scopes[0]);
    secondScope.scope_id = 'scope:zh-compulsory-2022-second';
    fixture.release.scopes.push(secondScope);
    const secondAssertion = copy(fixture.release.assertions[0]);
    secondAssertion.assertion_id = 'assertion:zh-compulsory-2022-second';
    secondAssertion.scope_id = secondScope.scope_id;
    fixture.release.assertions.push(secondAssertion);
    const child = copy(fixture.release.nodes[0]);
    child.id = 'ontology:zh-compulsory-2022-child';
    child.scope_id = secondScope.scope_id;
    child.parent_id = fixture.release.nodes[0].id;
    child.source_assertion_ids = [secondAssertion.assertion_id];
    fixture.release.nodes.push(child);
    fixture.release.release_gate.candidate_nodes_promoted = 2;
    const report = validateOntologyRelease(fixture.release, fixture.context);
    assert.equal(report.valid, false);
    assert.match(text(report), /cross_scope_parent/);
  });

  await t.test('parent cycle', () => {
    const fixture = reviewedFixture();
    const second = copy(fixture.release.nodes[0]);
    second.id = 'ontology:zh-compulsory-2022-second';
    second.parent_id = fixture.release.nodes[0].id;
    fixture.release.nodes[0].parent_id = second.id;
    fixture.release.nodes.push(second);
    fixture.release.release_gate.candidate_nodes_promoted = 2;
    fixture.release.release_gate.accepted_leaf_nodes = 0;
    const report = validateOntologyRelease(fixture.release, fixture.context);
    assert.equal(report.valid, false);
    assert.match(text(report), /parent_cycle/);
  });
});

test('a reviewed release with no accepted scholarly leaf is rejected', () => {
  const fixture = reviewedFixture();
  fixture.release.nodes[0].label_kind = 'navigation_container';
  fixture.release.nodes[0].review_status = 'reviewed_inference';
  fixture.release.nodes[0].citation_allowed = false;
  fixture.release.release_gate.accepted_leaf_nodes = 0;
  const report = validateOntologyRelease(fixture.release, fixture.context);
  assert.equal(report.valid, false);
  assert.match(text(report), /no_accepted_leaf_nodes|leaf_without_accepted_assertion/);
});

test('cross-version semantic relation needs accepted evidence and review from both editions', () => {
  const fixture = reviewedFixture();
  const secondScope = copy(fixture.release.scopes[0]);
  secondScope.scope_id = 'scope:zh-compulsory-2022-revision';
  secondScope.edition_id = 'edition:moe-2022-03-revision';
  fixture.release.scopes.push(secondScope);
  const secondAssertion = copy(fixture.release.assertions[0]);
  secondAssertion.assertion_id = 'assertion:zh-compulsory-2022-revision';
  secondAssertion.scope_id = secondScope.scope_id;
  secondAssertion.edition_id = secondScope.edition_id;
  secondAssertion.node_binding.node_id = 'ontology:zh-compulsory-2022-revision';
  fixture.release.assertions.push(secondAssertion);
  const secondNode = copy(fixture.release.nodes[0]);
  secondNode.id = 'ontology:zh-compulsory-2022-revision';
  secondNode.scope_id = secondScope.scope_id;
  secondNode.field_binding_assertion_id = secondAssertion.assertion_id;
  secondNode.source_assertion_ids = [secondAssertion.assertion_id];
  fixture.release.nodes.push(secondNode);
  const basis = 'deliberately incomplete negative fixture';
  fixture.release.relations = [{
    id: 'relation:zh-compulsory-2022-one-sided-reframe',
    relation_type: 'reframed_by',
    source: fixture.release.nodes[0].id,
    target: secondNode.id,
    scope_ids: [fixture.release.scopes[0].scope_id, secondScope.scope_id],
    assertion_basis: basis,
    assertion_basis_sha256: digest(basis),
    evidence_assertion_ids: [fixture.release.assertions[0].assertion_id],
    content_bindings: [{
      assertion_id: fixture.release.assertions[0].assertion_id,
      evidence_role: 'source_endpoint',
      text_start_offset: 0,
      text_end_offset: PARAGRAPH.length,
      text_sha256: digest(PARAGRAPH),
    }, {
      assertion_id: fixture.release.assertions[0].assertion_id,
      evidence_role: 'relation_statement',
      text_start_offset: 0,
      text_end_offset: PARAGRAPH.length,
      text_sha256: digest(PARAGRAPH),
    }],
    review_status: 'editor_reviewed',
    reviewer: {
      reviewer_id: 'reviewer:test-cross-version',
      reviewed_at: '2026-07-18T00:03:00Z',
      method: 'manual_cross_version_review',
    },
    semantic_relation_allowed: true,
  }];
  fixture.release.release_gate.candidate_nodes_promoted = 2;
  fixture.release.release_gate.accepted_leaf_nodes = 2;
  const report = validateOntologyRelease(fixture.release, fixture.context);
  assert.equal(report.valid, false);
  assert.match(text(report), /cross_version_two_sided_evidence_required/);
});

test('negative historical claims remain impossible while corpus coverage is incomplete', () => {
  const fixture = reviewedFixture();
  fixture.release.negative_historical_assertions = [{
    claim_id: 'negative-claim:first-core-competency',
    claim_type: 'first_appearance',
    scope_ids: [fixture.release.scopes[0].scope_id],
    surface_aliases: ['核心素养'],
    coverage_digest_sha256: SHA.coverage,
    evidence_assertion_ids: [fixture.release.assertions[0].assertion_id],
    reviewer: {
      reviewer_id: 'reviewer:test-negative',
      reviewed_at: '2026-07-18T00:04:00Z',
      method: 'manual_cross_version_review',
    },
  }];
  fixture.release.release_gate.complete_historical_coverage = true;
  fixture.release.release_gate.negative_historical_assertions_allowed = true;
  const report = validateOntologyRelease(fixture.release, fixture.context);
  assert.equal(report.valid, false);
  assert.match(text(report), /negative_historical_assertion_forbidden|complete_history_fabricated/);
});

test('zero-coverage facet cannot be relabeled as candidate or released', () => {
  const changed = copy(manifest);
  const labor = changed.facet_coverage.find((row) => row.subject_facet === '劳动');
  labor.status = 'candidate';
  labor.candidate_node_count = 1;
  const report = validateOntologyRelease(changed, context);
  assert.equal(report.valid, false);
  assert.match(text(report), /facet_candidate_node_count_mismatch|facet_status_mismatch|fabricated_zero_coverage/);
});

test('candidate flag changes are blocked and cannot become public builder inputs', () => {
  const candidate = copy(context.artifacts.candidate.json);
  candidate.release_boundary.public_data_update_allowed = true;
  const replacement = withArtifact(context, 'candidate', candidate);
  const changed = copy(manifest);
  changed.input_fingerprints.candidate.sha256 = replacement.artifact.sha256;
  const report = validateOntologyRelease(changed, replacement.context);
  assert.equal(report.valid, false);
  assert.match(text(report), /candidate_promotion_flag_open/);
  assert.equal(report.builder_isolated, true);
  assert.equal(replacement.context.artifacts.public_core.json.ontology_nodes.length, 169);
  assert.equal(replacement.context.artifacts.public_academic.json.ontology_nodes.length, 169);
  assert.doesNotMatch(replacement.context.builder_source, /ontology-candidates|ontology-release-manifest/);
});

test('offset and accepted text hashes are structural release evidence, not optional metadata', () => {
  const fixture = reviewedFixture();
  fixture.release.assertions[0].start_offset = 2;
  fixture.release.assertions[0].end_offset = fixture.release.assertions[0].start_offset;
  const report = validateOntologyRelease(fixture.release, fixture.context);
  assert.equal(report.valid, false);
  assert.match(text(report), /assertion_offset_error/);
});

test('CLI succeeds for contract validation but fails when current empty bridge is required to publish', () => {
  const script = new URL('../scripts/validate-ontology-release.mjs', import.meta.url).pathname;
  const cwd = new URL('../', import.meta.url).pathname;
  const valid = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr || valid.stdout);
  const publish = spawnSync(process.execPath, [script, '--require-publishable'], { cwd, encoding: 'utf8' });
  assert.equal(publish.status, 2, publish.stderr || publish.stdout);
  assert.match(publish.stdout, /"publishable": false/);
});
