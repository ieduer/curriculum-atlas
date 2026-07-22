# Subject ontology v2 ordinary rebind (2026-07-22)

## Scope and decision

This checkpoint starts from integration commit
`8c9e521f7291796aa12c6e81680efb8068bbc6ef`. It rebuilds the current
195-document catalog and 93-chunk corpus, then updates only the dependency bindings in
the empty subject-ontology-v2 index and its exact ordinary validation report.
It is not an ontology publication, OCR acceptance, research-evidence release,
or promotion transaction.

The checked-in ontology remains deliberately empty:

- all 12 canonical facets are `not_started`;
- every `scope_files` array is empty and no unregistered scope artifact exists;
- `coverage_universes` is empty;
- all scope, concept, and semantic-relation counts are zero;
- builder, public-data, semantic, and negative-history gates are false;
- page evidence is valid only in ordinary mode, with `publishable: false`, an
  empty bundle list, and all five publication counts equal to zero.

## Current rebuild identities and repeat-run behavior

The commands were run in this order:

```bash
npm run catalog
npm run corpus:build
npm run ontology:v2:ordinary:rebind
npm run ontology:v2:validate
```

The corpus manifest contains the governed `generated_at` audit timestamp, so a
rebuild whose governed payload changes is not described as byte-deterministic.
Once that changed payload has been materialized, the builder preserves its
prior timestamp on an unchanged rebuild. Two consecutive runs of
`corpus:build -> ontology:v2:ordinary:rebind -> ontology:v2:validate` produced
the identities below; both validations passed and both rebinds reported
`changed: false`. The formal `npm run verify` flow now enforces this same order,
so any future valid timestamp/envelope change is rebound before v2 validation.

The resulting identities are:

| Artifact | Identity |
| --- | --- |
| Catalog | 195 documents; SHA-256 `d67830c39f35d56e704fe79e2379cbd1baf6647c63de59519c4a63031e66afa3`; 282948 bytes |
| Corpus manifest file | SHA-256 `e50ecb8ed79bc3831e46bdcc7fa0a70958889fbeadda6306b1c5c0de4e2f39c6` |
| Corpus release | `corpus-dcbd84da9174feba5492e366` |
| Corpus release fingerprint | `dcbd84da9174feba5492e36655f9bd071d2b302819014a770a98b39fccfb7e75` |
| Corpus internal manifest SHA-256 | `8c25d80764ab0d8e82b66d76062e20a7f0933274d8e72077558b9a764110b6aa` |
| Ordinary page-evidence manifest | SHA-256 `269efa1f70d90541ad585dead3ee4a899221d123cb72057eb360315b952e622c`; zero publication |
| Rebound ontology index | SHA-256 `0af5af35def08bcc45affd6be1ed440b33dba50a29a73122e831993225eb48f1`; 6876 bytes |
| Recomputed ontology report | SHA-256 `e7e258e85fb87f40bafcdd5dbfa002c0d5a3b7c112fcf65c5354a0ffd5d813d7`; 2388 bytes |

The corpus contains 16,711 paragraphs, 16,711 FTS rows, 6,132 page-publication
gate rows, and zero accepted OCR documents. These counts describe the current
fail-closed corpus build; they do not imply that historical OCR pages are
citation-eligible.

## Ignored SQL chunk evidence

`data/corpus-chunks/*.sql` remains intentionally ignored by Git. The tracked
manifest binds every generated chunk individually by filename, byte count, and
SHA-256. The local post-build readback found exactly 93 regular non-symlink SQL
files, no missing or extra SQL name, and 46,569,436 total bytes.

For an additional compact readback, sort `manifest.sql_files` by filename and
hash the UTF-8 concatenation
`<name> NUL <sha256> NUL <bytes> LF`. The resulting inventory SHA-256 is:

```text
0421e6d65953c9ad924527071d96043541e86e7d025ee5f44c0763c76c3ffd45
```

The ignored SQL files are required private build artifacts. They must be kept
with this manifest until the private corpus bundle is rebuilt, verified, and
read back; they must not be inferred from the tracked manifest alone.

## Generator safety boundary

`npm run ontology:v2:ordinary:rebind` invokes
`scripts/rebind-subject-ontology-v2-ordinary.mjs`. The generator:

1. rejects every promotion flag;
2. schema-validates the current index and independently proves the exact empty
   ontology state before changing a byte;
3. rejects both registered and unregistered scope artifacts;
4. validates the real page-evidence release in ordinary mode and requires its
   raw bundles and recomputed counts to be empty;
5. requires the exact current 195-document/93-chunk corpus contract;
6. computes every binding from the actual regular, non-symlink file bytes;
7. creates the expected report in an isolated temporary shadow tree;
8. rechecks every input for drift, records exact before/after bytes in a
   no-replace, owner-bound temporary `prepared` transaction journal, refuses a
   journal whose owner process is still live, fsyncs every file and parent
   directory, and atomically renames each governed output; every temp path is
   derived from the journal's owner PID and transaction ID rather than random;
9. changes the journal to `validated` only after exact post-write validation,
   then removes it; startup rolls back any interrupted `prepared` transaction
   and completes cleanup only when a `validated` transaction contains both
   exact after-images, while removing only temp paths owned by that exact dead
   transaction;
10. writes no lasting artifact except
    `data/ontologies/index.json` and
    `data/subject-ontology-v2-validation.json`, is byte-idempotent, and
    preserves every non-binding byte of the index.

The interruption tests launch the real generator in child processes and send
`SIGKILL` in three separate windows: after journal-temp fsync but before its
no-replace link, after index-temp fsync but before rename, and after the index
rename but before the report rename. The next invocation removes only the
owner/transaction-derived temp, restores a prepared pair when required, and
performs the complete validated rebind. A nonmatching decoy file is retained.
These tests cover process death rather than only catchable JavaScript
exceptions.

The normal signed two-commit promotion path remains separate and cannot be
reached through this command.

## Deliberately deferred research binding

This checkpoint does not change
`data/research-evidence/zh-hs-2017-2020.json` or its release assets. That file
still names `corpus-4fe2f31344f52706de761788`. Its six source/page/online
witnesses must be replayed against the new corpus with the private resource map,
then independently reviewed before those research release bindings can change.
Keeping the old binding stale is an explicit fail-closed blocker, not evidence
that the research slice has been migrated.

## Other downstream fail-closed blockers

This narrow checkpoint intentionally does not rebuild the public concept graph
or the legacy ontology-release bridge. The full pre-closeout `npm test` run
isolated 10 downstream fingerprint failures; every other executed test passed
and two platform-specific tests were skipped. The subsequently updated focused
suite passes 43/43. The 10 full-suite failures are gates for artifacts that
still precede this corpus checkpoint:

- one concept-graph test: the public graph still binds corpus internal manifest
  `9c48e72c...`, not `8c25d807...`;
- two legacy ontology-release bridge tests: that bridge still binds the prior
  catalog bytes;
- seven release-manifest tests: release assembly rejects the same stale public
  graph catalog fingerprint before any publication work.

These failures must be cleared by separately rebuilding and independently
reviewing those derived assets. Weakening the gates or silently changing them
inside the ordinary v2 rebind would cross this task's authority boundary.
