# Immutable page evidence and publication binding

## Release state

Phase one is deliberately fail-closed. The checked-in release manifest is
`scripts/page-evidence/fail-closed-manifest.json`; it contains no bundles and
recomputes to zero documents, zero pages, zero display pages, zero citation
pages, and zero resolved semantic controls. It does not promote OCR candidates
or change the public corpus, search, AI retrieval, quotations, or concept graph.

Validate that state with:

```bash
node scripts/validate-page-evidence-publication.mjs
```

The command must report `valid: true`, `publishable: false`, and all-zero
counts. Promotion intentionally fails until signed, complete evidence exists:

```bash
node scripts/validate-page-evidence-publication.mjs --require-publishable
```

## What is actually verified

The validator never accepts a 64-character value as proof by itself. It opens
each bound regular file through its project-relative locator, rejects traversal
and out-of-root symlinks, reads it once through a stable file descriptor, and
recomputes its byte count and SHA-256. It then validates the content and the
cross-object relationships.

For each physical PDF page it verifies:

1. The source PDF is the catalog PDF, its bytes match the catalog checksum, its
   page count is read by MuPDF, and the page number is in range.
2. The page is rendered again in an operating-system temporary directory with
   the fixed `mutool draw` contract. The validator binds the MuPDF binary hash,
   version, DPI, PNG bytes, PNG hash, width, and height, then deletes only that
   temporary render. A permanently resident witness PNG is optional cache, not
   release evidence.
3. The primary `result.json`, `content.md`, and `state.json` are read as actual
   objects. Source identity, page completion, result/content hashes, DPI, page
   number, and dimensions are recomputed and cross-checked.
4. The Apple Vision sidecar is read independently. It must bind the same source
   PDF, physical page, freshly reproduced PNG and DPI, while retaining
   `citation_allowed: false` at the OCR-engine layer.
5. The audit metrics are recomputed from primary text and Vision lines using the
   production comparison algorithm. Stored hashes, headings, numbers,
   agreement, confidence, tables, critical fields, gate and summary must agree.
6. The adjudicated final text, online claim object, every captured online
   snapshot, and the signed reviewer decision are read and rehashed.

Existing witness PNGs must not be deleted merely because this contract supports
reproducible rendering. A separate dry run must first prove that the exact
source PDF, MuPDF binary/version, DPI and command reproduce the recorded hash.
Legacy renders without that proof remain retained evidence.

## Version-aware online corroboration

An online claim is bound to the same document id, physical PDF page, stable
locator, and five-field version identity as the scanned source. A claim marked
`exact_document_exact_edition` is rejected if any observed version field differs.
Different editions may remain as conflict or stable-fact context, but cannot
adjudicate exact wording or satisfy citation release.

Citation release requires at least two exact-edition claims from distinct HTTPS
hosts and distinct publishers, backed by different normalized snapshot content.
Same-host copies and same-content mirrors are not independent. Supporting text
must occur in the captured snapshot and both are rehashed. Search snippets or a
claim without a retained snapshot cannot pass.

## Critical fields and human uncertainty

Accepted pages require a non-empty Vision `critical_fields` array. Each field
has a stable id, kind, primary reading, and independent Vision reading. The
signed decision must cover the exact same field-id set and explicitly attest
that the declaration is complete.

`accepted_citation` requires every critical field to be either
`verified_exact` or `image_online_adjudicated`, no remaining uncertainty note,
an open document-level `catalog.citation_allowed` gate, and no table. Table
pages remain citation-blocked in phase one because a page-level declaration
cannot prove cell order.

`image_online_adjudicated` is the narrow correction path for a primary or
Vision OCR error. The field decision must name exactly which engine readings
differ from the accepted value and use the structured basis
`source_scan_image+adjudicated_final_text+signed_human_review+two_independent_exact_edition_online`.
The accepted value must occur in the bound final text and in the supporting text
of at least two independently verified exact-edition online page claims. The
canonical signature payload already binds the freshly rendered scan page, final
text, both OCR objects, online snapshots, and the human decision. A single
source, a search snippet, a different version, a same-host copy, or a
same-content mirror cannot activate this state.

`accepted_display_non_citation` must retain an uncertainty note. A human
judgment may therefore make a legible but imperfect page visible with a warning,
but it cannot silently open quotations, citation-locked AI, or exact-text reuse.
`unresolved_fail_closed` closes both display and citation and requires a note.

## Reviewer authority and same-batch mutation resistance

Review decisions use Ed25519 over a canonical payload derived from the actual
source/render/OCR/Vision/audit/final/online objects and the decision fields. The
signature excludes its own bytes but includes every evidence locator and every
non-self-referential recomputed hash and byte count. The reviewer-decision
locator is signed; that decision file's hash and bytes are then bound by the
bundle, page manifest, and release index to avoid a circular self-hash. Updating
a manifest and its evidence together therefore invalidates the previous
signature. The signed payload also includes the document citation gate and a
canonical SHA-256 of every resolved semantic-control object; changing catalog
citation authority or weakening a semantic policy while retaining its id cannot
reuse an older signature.

Any non-zero publication also requires the actual reviewer registry hash to
match an external pin:

```bash
PAGE_EVIDENCE_AUTHORITY_SHA256=<PINNED_SHA256> \
  node scripts/validate-page-evidence-publication.mjs \
  --manifest <PROJECT_RELATIVE_RELEASE_MANIFEST> \
  --require-publishable
```

The pin must come from the controlled release environment, not from the release
manifest being validated. Editing the registry and manifest in the same batch
cannot replace that authority.

## Page and semantic publication rules

- A page-publication document must list every physical page from 1 through the
  catalog and actual PDF page count. Partial page lists are rejected.
- Every listed page must reference exactly one verified bundle, and the release
  bundle index may contain no extra bundle.
- Source-page, final-text, evidence-bundle, reviewer, time, status, display,
  citation, and uncertainty fields must equal the recomputed bundle decision.
- Exact-source aliases cannot publish independently.
- An unresolved semantic control still closes display. A resolved control must
  name every covered page in a signed decision from a reviewer with
  `semantic_resolution` scope, and every covered page must have a verified,
  display-accepted bundle.
- The document-level catalog citation gate cannot be overridden by a page
  manifest or reviewer decision.

## Deployment integration contract

The shared deployment owner should import:

```js
import { validatePageEvidenceRelease } from './page-evidence-publication.mjs';

validatePageEvidenceRelease({
  root,
  evidenceManifestPath: 'scripts/page-evidence/fail-closed-manifest.json',
  requirePublishable: pageEvidencePromotion,
  authorityRegistrySha256: process.env.PAGE_EVIDENCE_AUTHORITY_SHA256 || null,
});
```

Preview and production paths must run the validator before build/release-manifest
generation or Wrangler. A dedicated page-evidence promotion command must set
`requirePublishable: true`. Phase one does not edit `package.json`,
`scripts/deploy-worker.mjs`, corpus builders, or ontology release files because
those files have separate active ownership.

## Test coverage

`tests/page-evidence-publication.test.mjs` creates a real PDF, renders it with
the installed MuPDF binary, signs a complete candidate, and then attacks the
gate with fake hashes, missing files, an out-of-range page, version mismatch,
same-source and same-content mirrors, empty critical fields, a fake reviewer, a
closed document citation gate, same-batch manifest/evidence edits, an authority
registry swap, and a partial page list. It also proves that a signed
`image_online_adjudicated` correction can pass only with two independent
exact-edition supporting texts, the exact deviating-engine record, and no search
snippet substitution, and that a same-batch semantic-policy rewrite cannot reuse
a signed control id.
