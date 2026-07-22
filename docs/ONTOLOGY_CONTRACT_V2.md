# Subject ontology v2 evidence contract

`data/ontologies/index.json` is a fail-closed registry for the future 12-facet, edition-scoped subject ontology. It is not the public graph and it is not evidence that any subject has been modeled. The checked-in index intentionally contains zero scopes, zero coverage universes, zero concepts, and zero semantic relations. Every release gate is closed. The canonical validator applies the byte-pinned Draft 2020-12 schema to the index and every registered scope before semantic validation.

The public facets remain exactly: 语文、数学、外语、思想政治与道德法治、历史、历史与社会、地理、科学类、技术、劳动、艺术、体育与健康. A source label enters one facet only after resolving through the byte-pinned `data/concept-model-v2.json`; special-education course labels such as 美工 and 定向行走 are not silently promoted to subjects.

## Two release modes

- `ordinary_nonpublishable` is the only checked-in and package-verification mode. It requires all 12 facets to be `not_started`, no scope files or self-authored coverage universes, and every builder/public/semantic/negative gate to be false.
- `explicit_promotion` is reachable only through `prepare-release.mjs` with both promotion flags. The builder requires a clean Git HEAD exactly equal to its upstream, materializes governed files from Git blobs, verifies every source-tree byte against that commit, hydrates only manifest-bound private corpus chunks, rebuilds the corpus in an in-memory SQLite database, and consumes the canonical publishable page-evidence result. The ontology index, schema, report, and every registered scope must be present in that exact Git/source-tree identity. There is no production API that accepts caller-provided index, scope, coverage, or context objects.

The initial v2 assets use the `candidate_fail_closed` disposition. They have explicit `subject_ontology_v2_validator` and `release_manifest` consumers, are absent from the R2 object list, and have no frontend consumer. `npm run verify` invokes the validator. Scope registry entries use one canonical form only: `data/ontologies/<facet>/<file>.json`. The schema, index validator, loader, and desired-release validator share `scripts/lib/subject-ontology-paths.mjs`; neither `./<facet>/...` nor `data/ontologies/facets/...` is accepted.

The release manifest embeds the exact index, schema, scope-artifact, validation-report, dependency, and coverage-authority identities in `release_identity.subject_ontology_v2`. For an explicit promotion it also creates an external `subject_ontology_v2_external_promotion_envelope_v1` only after the candidate is a clean committed Git tree. That desired-release envelope binds the Git HEAD, source-tree digest, index blob, and every scope blob by canonical path, SHA-256, and bytes. Scope JSON never contains its current commit or source-tree digest, so promotion is constructable without a cryptographic fixed point. The desired-release parser checks the envelope and raw artifacts against its source tree and cross-checks the corpus and page-evidence planes. A report or dependency drift therefore changes or invalidates the desired release identity.

## Exact evidence, not a private self-proof

A publishable ontology span does not embed its own page manifest or online transcription. It references identities returned by the existing canonical page-evidence release:

1. exact canonical page-evidence release-manifest SHA-256;
2. exact validated page-bundle SHA-256;
3. the signed Ed25519 reviewer-payload SHA-256, reviewer ID, and decision time;
4. at least two claim IDs from that bundle's externally pinned online-source registry;
5. the immutable corpus release ID, manifest SHA-256, and release-fingerprint SHA-256.

The validator resolves the actual corpus paragraph from the prepared SQL release, verifies document, edition, physical page, paragraph ordinal, display/citation gates and body SHA-256, then reapplies the declared UTF-16 slice to the real paragraph body. A self-reported quotation is insufficient.

Each selected online claim must already be an exact-document/exact-edition claim in the canonical page bundle. It must resolve all five exact version anchors: title, issuing body or author, year/publication context, version label, and section/item locator. At least two witnesses must have different HTTPS origins, publishers, and independence groups. Their capture-body and supporting-slice hashes enter downstream evidence identity. A same-commit `online_snapshot`, local mirror, search result, or caller-supplied registry cannot authorize a semantic claim.

## Per-subject coverage and version validity

Coverage is recomputed from the independent, byte-pinned `data/catalog.json`, `data/document-sources.json`, and taxonomy. The caller cannot choose its own subject set or time window. For every facet, the validator derives the complete eligible stable-subject-ID set from the governed taxonomy, freezes the authoritative as-of date from `catalog.generated_at`, derives the earliest catalog year, and fixes the allowed document functions. A universe must match those boundaries exactly and enumerate every eligible catalog document as included or excluded. Omitted subjects, shortened periods, future extensions, undated eligible records, and convenient prose exclusions all fail closed.

The frozen catalog projection retains all 195 catalog works, including non-facet records. The native 聋校、盲校、培智 and ordinary 义务教育课程设置方案 records are classified as `scope_plan_evidence`, never as subject editions. Their internal course rows (for example 定向行走、美工、沟通与交往) and section headings such as 学业质量 cannot create a top-level facet; the validator derives facet eligibility only from the pinned document-level taxonomy and never from OCR body tokens.

Current-ordinary and historical-negative universes are separate. The current universe is derived from the catalog's governed `current_reference` and `current_with_revision_watch` statuses; superseded or obsolete records cannot be relabeled as current. Work ID, normalized work title, edition validity interval, lineage kind, and predecessor document are also derived from the governed catalog projection, never accepted from a scope's self-description. Historical coverage cannot be inferred from current coverage or from another subject.

## Lineage and semantic relations

`first_edition` is only `first_edition_in_bounded_catalog_universe`, never an unqualified historical first. It has dedicated assertion text/hash, one exact current-edition evidence role, a signed human review, and an independently validated coverage universe.

`revision` has dedicated assertion text/hash and two exact roles: predecessor edition and current edition. Both scopes must match the governed work, subject, facet, validity, predecessor, and chronology; evidence must belong to the named exact scope. `rename` and every other academic relation likewise require distinct exact-edition endpoints, bilateral reviewed sense evidence, valid cardinality/chronology, and accepted review. Relation IDs, endpoint identities, and the type-plus-directed-endpoint semantic identity are globally unique; duplicated endpoint rows cannot satisfy split or merge cardinality. Cross-subject/work/facet relations require an exact-dimension exception plus a distinct second review.

Scope, lineage, coverage-universe, and cross-subject-exception reviews use `signed_subject_ontology_governed_review_v1`. Each payload is domain-separated by review kind and binds the exact reviewed subject, reviewer ID, decision time, decision, required `semantic_resolution` role, and pinned reviewer-registry SHA-256. Promotion verifies registry membership, active/revoked status, validity interval, role, payload digest, canonical Ed25519 signature bytes, and signature. Unsigned, expired, wrong-role, revoked, or unregistered reviewers fail closed.

Every relation also carries an Ed25519 `signed_subject_ontology_relation_adjudication_v1` decision by an active `semantic_resolution` reviewer in the pinned reviewer registry. The signed payload binds the relation type, its type-specific semantic basis (rename, broaden, split, and so on), assertion, exact endpoints, and fully resolved evidence. `relation_diff_sha256` additionally binds that adjudication. Changing `rename` to `broaden` while retaining identical spans—or recomputing the unsigned diff—still invalidates the signed semantic decision.

## Commands and current state

```bash
npm run ontology:v2:validate
node --test tests/subject-ontology-v2-contract.test.mjs

# After the reviewed index/scopes are committed and pushed, generate the
# deterministic promotion report. Review, commit, and push that report.
npm run ontology:v2:promotion:report

# Then build the exact promotion desired-release artifact; this still deploys nothing.
npm run release:manifest:ontology-v2:promotion
```

The two-commit promotion sequence is intentional. The generated report binds the index, schema, scope artifacts, corpus, page evidence, coverage, and reviewer inputs, but never its own bytes, the current commit, or the source-tree digest. Committing the generated report therefore closes the release gate without a cryptographic fixed point or same-commit self-authorization.

The deterministic report is `data/subject-ontology-v2-validation.json`. It currently proves only that the contract is valid and nonpublishable. It does not claim OCR acceptance, historical completeness, semantic relations, frontend integration, or production deployment.
