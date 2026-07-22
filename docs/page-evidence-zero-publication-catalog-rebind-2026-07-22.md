# Page-evidence zero-publication catalog rebind (2026-07-22)

## Decision

The checked-in page-evidence manifest may bind the source-recovery catalog at
`dff01a968a41a939a71726753dd8215dfbd53533`. This is a zero-publication identity
maintenance change only. It does not authorize an OCR page, displayed page,
citation, quotation, AI retrieval item, concept, relation, or semantic control.

The reviewed integration base is
`9564b3cb5ab845734649ba676f53be2f7de19395`. The catalog identities compared
were:

| Catalog | Git object | SHA-256 | Bytes |
| --- | --- | --- | ---: |
| Previous binding | `373627780303ba91ac7159f99b166c85f9a1b9af:data/catalog.json` | `7e0aa7d8c08de3ed2a7265ae2cd6e67263320c3a7c76c39f31a14173ba0c20b4` | 280284 |
| Source-recovery catalog | `dff01a968a41a939a71726753dd8215dfbd53533:data/catalog.json` | `d67830c39f35d56e704fe79e2379cbd1baf6647c63de59519c4a63031e66afa3` | 282948 |

## Catalog delta audit

The semantic comparison found all of the following:

- both catalogs contain exactly 195 documents;
- no document ID was added or removed, and document order is identical;
- top-level counts are identical;
- no title, work/version field, source URL, source PDF checksum, page count,
  local source path, text-quality status, or citation gate changed;
- `generated_at` changed from `2026-07-22T07:51:36.338Z` to
  `2026-07-22T08:51:51.784Z`;
- 37 source-recovery-governed records gained only the explicit fields
  `native_text_cache_path: null` and `native_text_sha256: null`;
- the other five governed records already carried non-null native-text
  identities and did not change;
- no record outside the 42-document source-recovery governed set changed.

This normalization is required by the independently reviewed source-recovery
identity contract. When the previous catalog is evaluated against the current
proof object it fails with 74 errors: one identity-shape and one canonical
artifact-binding error for each of the 37 incomplete identity tuples. The new
catalog produces zero proof errors. `sources:recovery:validate` also verifies
the exact 149 canonical PDFs, one 21-member official archive, 16 same-work
official scans, five native attachments, 86 OCR queue rows, six publication
pages, and 23 retained online artifacts.

## Zero-publication proof

Only the catalog reference changes in
`scripts/page-evidence/fail-closed-manifest.json`. All other bound artifacts
retain the same byte count and SHA-256. The release remains:

- `status: unresolved_fail_closed`;
- `bundles: []`;
- `data/page-publication-manifest.json` with `documents: []`;
- zero documents, pages, display pages, citation pages, and resolved semantic
  controls;
- 21 unresolved semantic controls and no resolved semantic control;
- `publishable: false` in ordinary validation;
- rejected by the dedicated promotion validation.

`tests/page-evidence-catalog-rebind.test.mjs` pins the reviewed current catalog
identity, requires every one of the 42 governed catalog records to carry the
complete explicit native-text identity shape, recomputes all zero-publication
counts, and proves promotion remains unavailable.

## Reproduction

```bash
git show 373627780303ba91ac7159f99b166c85f9a1b9af:data/catalog.json | sha256sum
git show dff01a968a41a939a71726753dd8215dfbd53533:data/catalog.json | sha256sum
git diff --stat 373627780303ba91ac7159f99b166c85f9a1b9af dff01a968a41a939a71726753dd8215dfbd53533 -- data/catalog.json
node --test tests/source-recovery-proofs.test.mjs tests/source-recovery-online-receipt.test.mjs
npm run sources:recovery:validate
node --test tests/page-evidence-catalog-rebind.test.mjs tests/page-evidence-release-hook.test.mjs tests/page-evidence-publication.test.mjs
npm run page-evidence:validate
node scripts/validate-page-evidence-publication.mjs --require-publishable
```

The final command must fail. A future non-zero release requires complete signed
page-evidence bundles, recomputed page and semantic manifests, external reviewer,
source and renderer pins, and the explicit page-evidence promotion path.

## Deferred derived-artifact rebuild

This audit does not regenerate the corpus or ontology bridge. A full `npm test`
at this isolated checkpoint therefore has two expected failures in
`tests/ontology-release-bridge.test.mjs`: the checked-in derived ontology bridge
still binds the previous catalog bytes. The failure is fail-closed and predates
this manifest-only rebind because `data/catalog.json` and the ontology artifacts
are unchanged from base `9564b3c`. The parent integration must rebuild and
re-review all catalog-derived artifacts once, after its remaining approved
component merges, instead of letting this narrow audit create a competing
derived release.
