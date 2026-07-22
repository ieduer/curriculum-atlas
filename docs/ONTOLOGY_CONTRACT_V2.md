# Subject ontology v2 evidence contract

`data/ontologies/index.json` is a fail-closed registry for the future 12-facet, edition-scoped subject ontology. It is not the public graph and it is not evidence that any subject has been modeled. The checked-in index intentionally contains zero scopes, zero coverage universes, zero concepts, and zero semantic relations. Every release gate is closed.

The public facets remain exactly: 语文、数学、外语、思想政治与道德法治、历史、历史与社会、地理、科学类、技术、劳动、艺术、体育与健康. A source label enters one facet only after resolving through the byte-pinned `data/concept-model-v2.json`; special-education course labels such as 美工 and 定向行走 are not silently promoted to subjects.

## Two release modes

- `ordinary_nonpublishable` is the only checked-in and package-verification mode. It requires all 12 facets to be `not_started`, no scope files or self-authored coverage universes, and every builder/public/semantic/negative gate to be false.
- `explicit_promotion` is a separate semantic validator mode. It is not reachable by adding files or flipping booleans. Production construction requires `createImmutablePreparedReleaseContext()`, which reopens the canonical desired-release artifact, requires a clean Git HEAD exactly equal to its upstream, rehashes every prepared source-tree file, revalidates the corpus manifest and all private SQL chunks, rebuilds the corpus in an in-memory SQLite database, and reruns the canonical page-evidence promotion validator. Serialized or caller-created objects that merely claim to be immutable contexts are rejected.

The initial v2 assets use the `candidate_fail_closed` disposition. They have explicit `subject_ontology_v2_validator` and `release_manifest` consumers, are absent from the R2 object list, and have no frontend consumer. `npm run verify` invokes the validator. The release manifest embeds the exact index, schema, validation-report, dependency, and boundary identities in `release_identity.subject_ontology_v2`; the canonical desired-release parser rejects their absence. Thus a report or dependency drift changes the desired release identity.

## Exact evidence, not a private self-proof

A publishable ontology span does not embed its own page manifest or online transcription. It references identities returned by the existing canonical page-evidence release:

1. exact canonical page-evidence release-manifest SHA-256;
2. exact validated page-bundle SHA-256;
3. the signed Ed25519 reviewer-payload SHA-256, reviewer ID, and decision time;
4. at least two claim IDs from that bundle's externally pinned online-source registry;
5. the immutable prepared Git tree and corpus release/fingerprint identities.

The validator resolves the actual corpus paragraph from the prepared SQL release, verifies document, edition, physical page, paragraph ordinal, display/citation gates and body SHA-256, then reapplies the declared UTF-16 slice to the real paragraph body. A self-reported quotation is insufficient.

Each selected online claim must already be an exact-document/exact-edition claim in the canonical page bundle. It must resolve all five exact version anchors: title, issuing body or author, year/publication context, version label, and section/item locator. At least two witnesses must have different HTTPS origins, publishers, and independence groups. Their capture-body and supporting-slice hashes enter downstream evidence identity. A same-commit `online_snapshot`, local mirror, search result, or caller-supplied registry cannot authorize a semantic claim.

## Per-subject coverage and version validity

Coverage is recomputed from the independent, byte-pinned `data/catalog.json`, `data/document-sources.json`, and taxonomy. A universe must enumerate every catalog document for its facet, subject set, and year boundary as included or excluded. Exclusion reasons are checked against the frozen record; an otherwise eligible document cannot be discarded with a convenient prose note.

The frozen catalog projection retains all 195 catalog works, including non-facet records. The native 聋校、盲校、培智 and ordinary 义务教育课程设置方案 records are classified as `scope_plan_evidence`, never as subject editions. Their internal course rows (for example 定向行走、美工、沟通与交往) and section headings such as 学业质量 cannot create a top-level facet; the validator derives facet eligibility only from the pinned document-level taxonomy and never from OCR body tokens.

Included scope editions carry explicit validity intervals. Continuity is checked independently for every subject ID across the complete boundary. Intervals from another subject cannot fill a gap. Current-ordinary and historical-negative universes are separate; current coverage cannot authorize a historical absence claim.

## Lineage and semantic relations

`first_edition` is only `first_edition_in_bounded_catalog_universe`, never an unqualified historical first. It has dedicated assertion text/hash, one exact current-edition evidence role, an accepted human review, and an independently validated coverage universe.

`revision` has dedicated assertion text/hash and two exact roles: predecessor edition and current edition. Both scopes must share work, subject and facet; edition IDs must differ; chronology must be forward; and evidence must belong to the named exact scope. `rename` and every other academic relation likewise require distinct exact-edition endpoints, bilateral reviewed sense evidence, valid cardinality/chronology, and accepted review. Cross-subject/work/facet relations require an exact-dimension exception plus a second accepted review.

`relation_diff_sha256` is recomputed over relation content, every endpoint, the resolved local span, page bundle, signed reviewer payload, corpus/Git identities, both online capture/slice identities, five anchors, and reviewer/policy revision. Changing an endpoint, edition, page bundle, online snapshot, reviewer, or policy invalidates the relation.

## Commands and current state

```bash
npm run ontology:v2:validate
node --test tests/subject-ontology-v2-contract.test.mjs
```

The deterministic report is `data/subject-ontology-v2-validation.json`. It currently proves only that the contract is valid and nonpublishable. It does not claim OCR acceptance, historical completeness, semantic relations, frontend integration, or production deployment.
