import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  validateZhCompulsory2022OnlineVerification,
} from '../scripts/validate-zh-compulsory-2022-online-verification.mjs';

const root = new URL('../', import.meta.url);
const [artifact, schema] = await Promise.all([
  readFile(new URL('data/online-verification/zh-compulsory-2022-claims.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('data/online-verification/zh-compulsory-2022-claims.schema.json', root), 'utf8').then(JSON.parse),
]);

const copy = () => structuredClone(artifact);
const validate = (candidate = artifact, candidateSchema = schema) => (
  validateZhCompulsory2022OnlineVerification(candidate, candidateSchema)
);
const errorText = (report) => report.errors.join('\n');

test('2022 compulsory Chinese online verification artifact is schema-valid and fail-closed', () => {
  const report = validate();
  assert.equal(report.valid, true, errorText(report));
  assert.deepEqual(report.counts, {
    sources: 17,
    independent_sources: 9,
    claims: 6,
    locked_claims: 6,
    version_mismatches: 3,
    transcription_conflicts: 5,
    interpretive_alignments: 1,
  });
  assert.equal(report.publication_unlock, false);
});

test('five confirmed claim families each have at least two exact-version independent web witnesses', () => {
  const sources = new Map(artifact.sources.map((source) => [source.source_id, source]));
  const confirmedClaims = artifact.claims.filter((claim) => claim.verification_status === 'independently_crosschecked');
  assert.equal(confirmedClaims.length, 5);

  for (const claim of confirmedClaims) {
    const witnesses = claim.crosschecks.filter((crosscheck) => crosscheck.role === 'independent_exact_support');
    assert.ok(witnesses.length >= 2, `${claim.claim_id} only has ${witnesses.length} independent witnesses`);
    for (const witness of witnesses) {
      const source = sources.get(witness.source_id);
      assert.equal(witness.independent_for_claim, true);
      assert.equal(source.independent_text_decision, true);
      assert.equal(source.evidence_role, 'independent_text');
      assert.equal(source.version_relation, 'exact_2022_edition');
      assert.match(source.url, /^https:\/\//);
    }
  }
});

test('ICTR URL is retained only as the same SHA artifact mirror and adds no independent evidence', () => {
  const primary = artifact.sources.find((source) => source.source_id === 'source:moe-2022-chinese-pdf');
  const mirror = artifact.sources.find((source) => source.source_id === 'source:ictr-2022-chinese-pdf');
  const equivalence = artifact.artifact_equivalence[0];

  assert.equal(mirror.artifact_sha256, primary.artifact_sha256);
  assert.equal(mirror.evidence_role, 'same_artifact_mirror');
  assert.equal(mirror.same_artifact_as, primary.source_id);
  assert.equal(mirror.independent_text_decision, false);
  assert.equal(equivalence.classification, 'same_artifact_mirror');
  assert.equal(equivalence.independent_evidence_increment, 0);
});

test('nine overall goals remain partial and conflicted, including the known goal 6 online error', () => {
  const goals = artifact.claims.find((claim) => claim.claim_id === 'claim:overall-goals');
  assert.equal(goals.verification_status, 'partial_conflicted');
  assert.equal(goals.ordered_items.length, 9);
  assert.match(goals.ordered_items[5].text, /提高语言表现力和创造力，提高形象思维能力/);
  assert.doesNotMatch(goals.ordered_items[5].text, /提升形象思维能力/);
  assert.ok(goals.crosschecks.some((crosscheck) => (
    crosscheck.source_id === 'source:nmg-goals-interpretation'
      && crosscheck.role === 'conflicting_transcription'
      && crosscheck.independent_for_claim === false
  )));
  assert.ok(goals.crosschecks.some((crosscheck) => (
    crosscheck.source_id === 'source:pep-goal6-2024-06'
      && crosscheck.role === 'partial_support'
      && crosscheck.independent_for_claim === true
  )));
});

test('2025 revision, high-school standard and blind-school standard are quarantined as version mismatches', () => {
  const expected = new Map([
    ['source:hep-2025-revision', 'edition_revision'],
    ['source:moe-highschool-2020', 'education_stage'],
    ['source:ictr-blindschool-2016', 'school_type'],
  ]);
  const sources = new Map(artifact.sources.map((source) => [source.source_id, source]));

  assert.equal(artifact.version_mismatch_controls.length, 3);
  for (const control of artifact.version_mismatch_controls) {
    assert.equal(control.mismatch_dimension, expected.get(control.source_id));
    assert.deepEqual(new Set(control.forbidden_uses), new Set([
      'wording_adjudication',
      'concept_identity_merge',
      'publication_unlock',
    ]));
    assert.equal(control.publication_unlock, false);
    assert.equal(sources.get(control.source_id).evidence_role, 'version_mismatch');
    assert.equal(sources.get(control.source_id).independent_text_decision, false);
  }
});

test('all five located OCR or online-transcription errors retain source-image-wins decisions', () => {
  const expectedReadings = new Map([
    ['conflict:page-9-life-basis', ['以生活基础', '以生活为基础']],
    ['conflict:page-9-task-carrier', ['以学习任务载体', '以学习任务为载体']],
    ['conflict:page-13-culture-word', ['感受多样化', '感受多样文化']],
    ['conflict:page-13-goal6-raise', ['提升形象思维能力', '提高形象思维能力']],
    ['conflict:page-44-quality-basis', ['核心素养评价提供基本依据', '为核心素养评价提供基本依据']],
  ]);

  assert.equal(artifact.transcription_conflicts.length, 5);
  for (const conflict of artifact.transcription_conflicts) {
    assert.deepEqual(
      [conflict.rejected_reading, conflict.accepted_reading],
      expectedReadings.get(conflict.conflict_id),
    );
    assert.equal(conflict.decision, 'source_image_wins');
    assert.equal(conflict.source_image_status, 'human_verified');
    assert.equal(conflict.publication_unlock, false);
    assert.ok(conflict.evidence_source_ids.includes('source:moe-2022-chinese-pdf'));
  }
});

test('goal-to-core alignment stays interpretive, nonexclusive and semantically inert', () => {
  const alignment = artifact.interpretive_alignments[0];
  assert.equal(alignment.status, 'interpretive_nonexclusive');
  assert.equal(alignment.normative, false);
  assert.equal(alignment.semantic_relation_allowed, false);
  assert.equal(alignment.publication_unlock, false);
  assert.deepEqual(alignment.mappings, [
    { goal_numbers: [1], target_label: '立德树人' },
    { goal_numbers: [2, 3], target_label: '文化自信' },
    { goal_numbers: [4, 5], target_label: '语言运用' },
    { goal_numbers: [6, 7], target_label: '思维能力' },
    { goal_numbers: [8, 9], target_label: '审美创造' },
  ]);
});

test('validator rejects every prohibited promotion or known evidence drift', async (t) => {
  const cases = [
    {
      name: 'claim publication unlock',
      mutate(candidate) {
        candidate.claims[0].publication_unlock = true;
      },
      expected: /claim_unlock_forbidden|must equal false/,
    },
    {
      name: 'same-artifact mirror promoted to independent evidence',
      mutate(candidate) {
        candidate.sources.find((source) => source.source_id === 'source:ictr-2022-chinese-pdf').independent_text_decision = true;
      },
      expected: /mirror_independence_error|quarantined_source_promoted/,
    },
    {
      name: 'goal 6 online mistranscription restored',
      mutate(candidate) {
        candidate.claims
          .find((claim) => claim.claim_id === 'claim:overall-goals')
          .ordered_items[5]
          .text = candidate.claims
            .find((claim) => claim.claim_id === 'claim:overall-goals')
            .ordered_items[5]
            .text
            .replace('提高形象思维能力', '提升形象思维能力');
      },
      expected: /goal_text_drift|goal6_known_error_restored/,
    },
    {
      name: '2025 revision mismatch control removed',
      mutate(candidate) {
        candidate.version_mismatch_controls = candidate.version_mismatch_controls
          .filter((control) => control.source_id !== 'source:hep-2025-revision');
      },
      expected: /missing_version_mismatch_control|must contain at least 3 items/,
    },
    {
      name: 'interpretive mapping promoted to normative',
      mutate(candidate) {
        candidate.interpretive_alignments[0].normative = true;
      },
      expected: /alignment_normative_promotion|must equal false/,
    },
    {
      name: 'source image conflict decision weakened',
      mutate(candidate) {
        candidate.transcription_conflicts[0].decision = 'online_text_wins';
      },
      expected: /conflict_decision_drift|must equal "source_image_wins"/,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const candidate = copy();
      entry.mutate(candidate);
      const report = validate(candidate);
      assert.equal(report.valid, false);
      assert.match(errorText(report), entry.expected);
    });
  }
});

test('schema itself hard-codes the fail-closed and source-image-wins invariants', () => {
  assert.equal(schema.$defs.publicationLocked.const, false);
  assert.equal(schema.$defs.artifactEquivalence.properties.independent_evidence_increment.const, 0);
  assert.equal(schema.$defs.claim.properties.normative.const, true);
  assert.equal(schema.$defs.interpretiveAlignment.properties.normative.const, false);
  assert.equal(schema.$defs.interpretiveAlignment.properties.semantic_relation_allowed.const, false);
  assert.equal(schema.$defs.transcriptionConflict.properties.decision.const, 'source_image_wins');
  assert.equal(schema.$defs.transcriptionConflict.properties.source_image_status.const, 'human_verified');
});
