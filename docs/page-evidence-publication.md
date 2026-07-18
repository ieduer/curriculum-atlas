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
2. The already-read source PDF bytes and already-hashed MuPDF bytes are copied
   into a random mode-0700 private directory. The input directory and files
   become read-only, their descriptors stay open, and device/inode/size/mtime
   plus complete hashes are checked after `mutool info` and `mutool draw`.
   MuPDF never reopens the original hash-then-path target. The signed render
   binds `verified_private_fixed_inode_copy_v1`, the externally pinned binary
   hash and exact version, DPI, PNG bytes/hash, width and height.
3. The primary `result.json`, `content.md`, and `state.json` are read as actual
   objects. Each page-state row must bind the source PDF hash, physical page,
   DPI, fresh render hash, result/content hashes and completed state.
4. The Apple Vision sidecar and a separate raw Vision-text artifact are read.
   Ordered sidecar lines must reproduce the raw text byte for byte. Confidence
   values must be JSON numbers, never coercible strings.
5. The audit metrics are recomputed from primary text and Vision lines using the
   production comparison algorithm. Stored hashes, headings, numbers,
   agreement, confidence, tables, critical fields, gate and summary must agree.
6. Duplicate JSON object keys, unsafe integers and noncanonical UTC timestamps
   are rejected before content validation. The final text, retained online
   capture bodies and signed decision are then read and rehashed.

Existing witness PNGs must not be deleted merely because this contract supports
reproducible rendering. A separate dry run must first prove that the exact
source PDF, MuPDF binary/version, DPI and command reproduce the recorded hash.
Legacy renders without that proof remain retained evidence.

## Version-aware online corroboration

Online authority comes from an externally hash-pinned source registry. A claim
may name only an active pinned source id; the registry, not claim prose,
supplies canonical origin/publisher, official or academic class, independence
group, allowed paths, search-service status and boilerplate markers.

Every capture binds tool/version, requested and final HTTPS URL, HTTP status,
media type, canonical millisecond timestamp and retained body bytes. Search
hosts, paths and query parameters are rejected. `www`, trailing-dot hosts,
zero-width characters and Unicode publisher variants are canonicalized before
identity and independence checks.

Supporting text is an exact locator/start-byte/end-byte/slice-hash reference
into the body. Five raw anchors bind title, issuing body, date/context, edition
and page locator. Exact-edition status is recomputed from those bytes;
claim-side `source_type` or `observed_version` labels cannot self-certify it.
Citation requires two exact-edition claims with distinct pinned origins,
canonical publishers and independence groups. Bodies must also remain distinct
after pinned boilerplate removal, so cosmetic wrappers cannot create a second
witness.

## Critical fields and human uncertainty

Accepted pages require a non-empty Vision `critical_fields` array. A field does
not contain self-reported OCR strings: primary and Vision readings both carry
the raw-artifact locator, UTF-8 byte offsets and slice hash. The validator
recomputes both slices and signs their references plus actual decoded values.
Decimal points, signs, range dashes, slashes, percent signs and comparison
operators remain significant (`20-22` is not `2022`).

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
signature. The signed payload also includes the document citation gate, every
complete resolved semantic-control object, its resolved full quality profile
and the revision hash of the complete normalized semantic policy. A profile or
policy edit cannot reuse a signature merely by retaining the same control id.

Any non-zero publication requires four independent release-environment pins:
the reviewer registry, online source registry, exact MuPDF binary and exact
MuPDF version output:

```bash
PAGE_EVIDENCE_AUTHORITY_SHA256=<PINNED_SHA256> \
PAGE_EVIDENCE_SOURCE_IDENTITIES_SHA256=<PINNED_SHA256> \
PAGE_EVIDENCE_RENDERER_SHA256=<PINNED_SHA256> \
PAGE_EVIDENCE_RENDERER_VERSION='<EXACT_MUTOOL_VERSION_OUTPUT>' \
  node scripts/validate-page-evidence-publication.mjs \
  --manifest <PROJECT_RELATIVE_RELEASE_MANIFEST> \
  --require-publishable
```

The pins must come from the controlled release environment, not from the
release manifest. Coordinated registry, renderer declaration and manifest edits
cannot replace those authorities.

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

`scripts/page-evidence-release-hook.mjs` is the single release-mode adapter.
Formal verification, direct corpus build/import, release-manifest generation and
Worker deployment all invoke it before generating data or contacting D1 or
Wrangler. Ordinary mode accepts only a valid non-publishable fail-closed state;
if evidence becomes publishable, the ordinary path stops and requires an
explicit promotion path.

The ordinary gate is:

```bash
npm run page-evidence:validate
```

The dedicated preview and production promotion commands are:

```bash
npm run deploy:page-evidence:preview
npm run deploy:page-evidence:production
```

The R2 metadata publication path has separate, default-off promotion commands:

```bash
npm run metadata:publish:page-evidence:preview
npm run metadata:publish:page-evidence:production
```

Ordinary metadata commands require `publishable: false`; the two commands above
pass the literal `--page-evidence-promotion` flag and require
`publishable: true` before the first R2 read or write. Both the high-level
metadata publisher and the lower-level immutable release publisher enforce the
same explicit mode against the page-evidence result embedded in the generated
release manifest. The lower-level publisher also rereads the exact raw corpus
manifest and checks its full byte/hash binding before any remote command.

For promotion, pin one renderer path for the whole command so release-manifest
generation and its page-evidence validation open the same operator-selected
binary. The validator still copies the already-open source PDF and renderer
bytes into its private fixed-inode verification directory before rendering:

```bash
npm run metadata:publish:page-evidence:preview -- --renderer <MUTOOL_PATH>
npm run deploy:page-evidence:preview -- --renderer <MUTOOL_PATH>
```

Those commands pass the literal `--page-evidence-promotion` flag. Direct corpus
build, corpus import and release-manifest entrypoints accept that same explicit
flag when they are part of the controlled promotion sequence. Promotion mode
sets `requirePublishable: true`; it cannot be enabled by a generic environment
toggle. The four external authority/source/renderer pins above remain mandatory.

The generated corpus manifest itself is an exact-schema sealed envelope. Its
canonical millisecond UTC timestamp, document and paragraph counts, OCR closure
counts, alias/skip counts, page/semantic schema versions, semantic policy
revision, text-asset inventory and SQL chunk inventory are all covered by
`manifest_sha256`. Identical consecutive corpus builds reuse the previous
validated timestamp only when the entire sealed envelope is byte-for-byte
unchanged; a content change receives a fresh timestamp. Import and release
generation also revalidate the live page/semantic source schema and semantic
revision, while a generated R2 release keeps the raw corpus file SHA-256 and
byte length in its release identity.

## Test coverage

`tests/page-evidence-publication.test.mjs` creates a real PDF, renders it with
the installed MuPDF binary, signs a complete candidate, and then attacks the
gate with fake hashes, missing files, out-of-range pages, raw-slice/anchor
forgeries, search URLs, invalid capture provenance, same-source and
boilerplate-stripped mirrors, empty critical fields, string confidence,
duplicate JSON keys, unsafe integers, noncanonical timestamps, state/render
drift, authority/source/renderer pin swaps, semantic profile/policy revision
edits and partial page lists. It also proves that a signed
`image_online_adjudicated` correction can pass only with two independent
exact-edition supporting texts, the exact deviating-engine record, and no search
snippet substitution, and that a same-batch semantic-policy rewrite cannot reuse
a signed control id.
