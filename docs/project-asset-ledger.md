# Project asset ledger and fail-closed audit

This project treats an asset as the SHA-256 identity of a source payload, not merely as a filename. The authoritative ledger is the joined view of:

1. `data/catalog.json` — canonical document records and `scan_variants`;
2. `data/document-sources.json` — verified source endpoint checksums;
3. `data/ingest-manifest.json` — payloads actually fetched by the ingest layer;
4. `data/artifact-registry.json` — explicit aliases, cross-validation variants, derived files, quarantined payloads, and source archive containers.

`scripts/audit-project-assets.mjs` reconstructs that joined view from disk. It is read-only and fail closed: an unregistered hash, ambiguous disposition, missing declared path, checksum or magic drift, queue coverage gap, or unregistered relevant Downloads file causes exit status `1`.

## Dispositions

- `canonical`: a recognized source payload. This does not by itself make its text citation-ready; catalog and page publication quality gates still apply.
- `variant`: a same-edition or alternate scan retained only for image, page-order, and character cross-checking. It cannot enter the OCR queue or publication output.
- `derived`: a transformed payload such as a PDF with an added OCR layer. It remains blocked until its parent hash, reproducible transformation parameters, and page-level quality evidence are complete.
- `quarantine`: an invalid or rejected payload retained as failure evidence. It cannot enter OCR, corpus, concepts, citations, or publication.

## Verified snapshot

The 2026-07-17 full scan established:

- data layer: 196 catalog documents, 163 source records, and 196 ingest records with exact catalog/ingest ID parity;
- local source roots: 245 `.pdf` paths representing 209 unique SHA-256 artifacts;
- PDF magic: 241 valid PDF paths and 4 invalid paths, with the invalid paths represented by 3 explicitly quarantined artifacts; the later byte-level recovery audit proved that two were zero-prefix corruptions rather than all-zero payloads;
- unique dispositions: 201 canonical, 3 variant, 2 derived, and 3 quarantine artifacts;
- one verified source archive container, `.cache/sources/moe-hs-2020.zip`, including its SHA-256, byte size, and ZIP magic;
- OCR queue: 86 nominal records / 11,847 pages, but 85 unique source artifacts / 11,779 unique pages;
- the 68-page labor standard is the only duplicate queue artifact: `moe-2022-17` is canonical and `ictr-6c6df9d121ac` is its exact-source alias;
- `/Users/ylsuen/Downloads`: 15 curriculum-compendium PDFs matched the scope, all 15 had unique hashes, and all 15 were already ingested into the registered source roots.

The three forgotten alternate scans are now explicit `variant` records. The two standalone OCR-layer PDFs are explicit `derived` records and remain publication-blocked because their transformation lineage is incomplete. The invalid ICTR payloads are explicit `quarantine` records rather than PDFs.

### 2026-07-22 identity correction

The Ministry of Education directory and rendered title page identify `W020220418401384948134.pdf` as the **junior-secondary** science standard, not a primary-school standard. The catalog title is corrected to `义务教育初中科学课程标准（2011年版）`. The 89-page Ministry file remains canonical `moe-2011-12`; the different 88-page ICTR scan is retained as `moe-2011-12-ictr-scan`, with `same_edition_cross_validation_scan`, `queue_eligible=false`, and `publication_eligible=false`. It is no longer a second document identity.

The corrected local data layer contains 195 catalog/ingest identities, 163 source records, 245 PDF paths / 209 unique artifacts, and 9 explicit artifact records. The OCR queue is 85 nominal documents / 11,759 pages and 84 unique entities / 11,691 pages. This correction does not delete either source file and does not retroactively alter the immutable 2026-07-17 production receipts above.

### 2026-07-22 exact source recovery and version adjudication

`data/source-recovery-proofs.json` now binds the recovery decision to exact bytes instead of filenames or matching titles. The executable gate verifies:

- two corrupt ICTR endpoints whose first 8,192 bytes are zero while every later byte matches a recovered official artifact; neither payload may be described as all-zero or used as text;
- the Ministry of Education 2017 RAR container (`074988…`) and all 21 exact member identities, member hashes and byte sizes, with every PDF page count recomputed from the extracted member bytes;
- 16 Ministry of Education 2003 same-work scans, with only the 144-page English scan selected as the canonical OCR input and the other 15 retained as non-publication variants;
- five native Office attachments whose cached text must be byte-identical to a fresh system conversion of the fixed DOC/DOCX bytes; Office pagination is never a stable citation locator;
- the unresolved `司法调解` / `司法调节` one-character attachment conflict, which keeps the political standard non-citable until exact-artifact adjudication.

The current candidate inventory is 195 catalog/ingest identities and 163 source records; 263 PDF paths represent 227 unique artifacts, of which 259 paths have valid PDF magic and 4 remain invalid. The OCR queue is 86 nominal documents / 11,903 pages and 85 unique artifacts / 11,835 pages. `document-sources.json` now enforces the catalog canonical URL as the only primary source for each work: recovered Ministry artifacts are primary, corrupt endpoints are quarantined alternates, and conflicting attachment variants are non-primary evidence.

The proof also binds all 42 touched catalog identities across the complete governed work identity (ID, country, language, title, subject, stage, document type, version, issuer, issue/publication dates, and current status) and a separate complete canonical-artifact identity. The local gate physically runs `pdfinfo` against all 149 canonical catalog PDFs and exact-binds all 86 OCR queue entries to catalog path/hash/page metadata. Exactly the two named zero-prefix corrupt recoveries, and no caller-selected substitutes, map one-to-one to their named quarantine artifacts.

`data/source-recovery-online-receipt.json` is a proof-hash-bound 72-hour receipt for 6 official publication pages and 23 exact online artifacts. It records page and artifact redirect chains, status, MIME, bytes, SHA-256, page href identity, and the narrow ICTR WAF-interstitial exception; placeholder hosts, 404s, missing hrefs, and stale receipts fail closed. Ordinary tests use injectable fetch fixtures and make no network request. `prepare-release.mjs` and `deploy-worker.mjs` independently require a fresh immutable receipt before any injected release preparer or Wrangler call. The proof, receipt, and schemas are versioned public release metadata, while source binaries remain in the private cache. `npm run assets:audit` validates both metadata layers automatically; release manifest construction refuses to omit them.

## Commands

Audit the project-owned source roots and OCR queue:

```bash
cd /Users/ylsuen/CF/curriculum-atlas
node scripts/audit-project-assets.mjs
```

Also reconcile curriculum-related PDFs in Downloads:

```bash
cd /Users/ylsuen/CF/curriculum-atlas
node scripts/audit-project-assets.mjs --downloads /Users/ylsuen/Downloads
```

Run the focused regression suite:

```bash
cd /Users/ylsuen/CF/curriculum-atlas
node --test tests/project-asset-audit.test.mjs
```

Validate the exact recovery proof against local bytes and every RAR member:

```bash
cd /Users/ylsuen/CF/curriculum-atlas
npm run sources:recovery:validate
```

Refresh the online receipt only when network verification is intended, then review and commit the exact diff:

```bash
npm run sources:recovery:online:refresh
npm run sources:recovery:validate
```

The audit writes JSON only to standard output. It does not modify a cache, rebuild a catalog, enqueue OCR, publish data, deploy code, or contact a remote host.

## Adding or reclassifying an asset

1. Record the payload SHA-256, byte size, path, provenance, edition relationship, and intended document.
2. Put a canonical payload into the normal catalog/ingest/source records. Put a noncanonical payload into `data/artifact-registry.json` with exactly one of `variant`, `derived`, or `quarantine`.
3. For a duplicate document identity, add one exact alias mapping with one canonical document ID and all aliases sharing the same SHA-256.
4. Keep every noncanonical artifact `queue_eligible: false` and `publication_eligible: false` until a separate adjudication changes its status.
5. Update expected counts only after the new physical inventory and data records have been reviewed together.
6. Run both audit commands. Do not regenerate the OCR denominator or publish until both return `ok: true`.

## Remaining boundaries

- The audit proves file identity, PDF/ZIP magic, registry coverage, catalog/ingest parity, and OCR queue integrity. It does not replace rendered-page checks, true PDF page-count verification, OCR image/text comparison, same-edition online verification, or citation review.
- The two derived OCR-layer PDFs intentionally produce warnings until their exact tools and parameters are reproducible. They remain blocked, so the warnings do not weaken the gate.
- `.cache` and OCR evidence trees are ignored by Git. This audit detects local omission or drift but does not create an off-host backup or make the payloads durable.
- Remote OCR offload manifests, receipts, repair bundles, and corpus SQL chunks are separate evidence layers. They need their own durable manifest/backup gate; this source-asset audit does not claim to archive them.
- The project-owned audit is wired into `npm run verify` and release-manifest generation. `npm run assets:audit:downloads` remains an explicit workstation-only gate because `/Users/ylsuen/Downloads` is unavailable in standalone clones and CI runners.
