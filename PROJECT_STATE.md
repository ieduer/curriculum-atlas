## Current accepted state — 2026-10-26 12:50 UTC

Owner: suen. Runtime source `538e2cfcaf9b31b9f20d7536edee80a58a61bb98`
(branch `claude/curriculum-redesign-20261026`, fast-forwarded into `main`),
Worker version `e078241f-55c0-4e1b-a722-5764e5f71002` at 100%, deployment
`474b1e56-85d8-4cdc-9403-dc2927cb59da`, effective 12:50:15 UTC. The Worker
module is byte-identical to the previous accepted bundle (`e70685f2…`); the
release changes static assets only (per-subject static redesign; see “前端合同”
below) and `RELEASE_GIT_COMMIT`. Asset header rules changed exactly as
`dist/_headers` (root `/*.js`, `/*.css` one-hour rules dropped; hashed
`/assets/*` immutable). Rollback: version `e4c24bc4-1015-4a35-84d2-77a5466c37f8`
(source `93fece8`, deployment `f38e0f33`) via a new registered transaction; no
data to restore. Preview Worker active deployment unchanged (`fc259ebe`);
immutable preview version `e935b39d` (source `538e2cf`) exists, not deployed.

Gate (front-end release): `tsc`; full suite 652 pass / 3 fail / 2 skipped with
the same 3 failures as base `fd63e2d` (645/3/2) and +7 site-build tests; build
and dry-run (production and preview bundles equal the live module); readability
audit 12 routes × light/dark × 1440/390, 0 failures, minimum contrast 6.21:1;
gitleaks clean; preview-version, version-pinned and production probes (all dist
files byte-equal after stripping edge-injected Zaraz/Web Analytics/bot links;
fallback routes; immutable asset cache; CSP; document/search 200; unauthenticated
AI refused); live browser check with no `/api` call on home load. Signed-in
paths (AI answer, historical scans, posting) were not exercised by the agent;
their Worker code is unchanged. `release:gates:check` still fails on the retired
OCR state and was not run.

Public record: status.bdfz.net `20261026-curriculum-subject-redesign` r1.
Evidence and receipts: `/Users/ylsuen/CF/_meta/reports/operations/curriculum-redesign-20261026/README.md`.

## Previous accepted state — 2026-10-17 08:50 UTC (superseded 2026-10-26)

Owner: suen. Runtime source `93fece839bdebbc27486d72214aa33700ef1b205`
(branch `claude/apis-compat-20261015`, merged into `main`), Worker
`e4c24bc4-1015-4a35-84d2-77a5466c37f8` at 100%, deployment
`f38e0f33-feb5-49c7-9de3-ffc984b939e0`, effective 08:50:38 UTC. Accepted after
version-pinned and production probes (health ok naming the source, `/` and all
84 `dist` files byte-equal to the build, unauthenticated AI refused) and the
owner's signed-in cited answer. Rollback: Worker
`f3e955af-89ca-4daf-8aab-79f3200d0123` (source `04c6831`, deployment
`c2b2baa4`) via a new registered transaction; retain all forward D1/R2 data.
The preview Worker's active deployment is unchanged (`fc259ebe`); immutable
preview version `53ef5ba4` (source `93fece8`) exists and is not deployed.

Change (APIS payload-contract rollout, phase A1): AI evidence answers send
retrieved passages whole, in retrieval order, within 160 KiB; an oversize
passage is skipped whole; only sent passages can be cited; responses add
`contextCount` next to `retrievalCount`; a typed 422 when no passage fits. No
asset, corpus, data, binding, route or schema change.

Release gate: `npm run release:gates:check` fails identically on `04c6831` and
`93fece8` because the retired OCR `.cache` state is deleted (7 of 10
sub-gates). Do not recreate that state. For this code-only release the owner
approved the code-only gate: TypeScript; the full suite (645 pass, 3 fail, 2
skipped, the same 3 failures as the base); the 3 runnable sub-gates
(`ocr:coverage`, `candidate:schema`, `release:episodes`); build and strict
dry-run; base build byte-identical to the live bundle; reviewed bundle diff;
secret scan. Run `npm test` with `TMPDIR` in a directory owned by the user's
group (`staff`): under `/private/tmp` new files get group `wheel` and 49 OCR
runner tests fail spuriously.

Upload: pass `--keep-vars --var RELEASE_GIT_COMMIT:<sha>` (as
`scripts/deploy-worker.mjs` does), so `/api/health` names the source. Script
settings carry that variable too, so configuration reconciliation must
account for it.

Public record: status.bdfz.net `20261017-curriculum-ai-evidence-context` r1.
Evidence and receipts:
`/Users/ylsuen/CF/_meta/reports/operations/apis-upgrade-design-20261014/RELEASE-ATLAS-20261017/README.md`.
The dated records below are history where superseded by this state.

## Previous accepted state — 2026-10-07 12:08 UTC (superseded 2026-10-17)

Owner: suen. Runtime source `04c6831a2b412c1ef1d79d694dfe69b2dff2f37b`,
Worker `f3e955af-89ca-4daf-8aab-79f3200d0123` at 100%, deployment
`c2b2baa4-db7c-4054-828b-ac404ea389ab`. Production became effective at
12:03:37 UTC and was accepted after runtime/configuration, real API, asset
and desktop/mobile readback. Rollback is the prior Worker
`09832541-e347-4fab-b64e-8b2072010c80` via a new registered transaction;
retain all forward D1/R2 data. The existing preview deployment is unchanged.

Paragraph and publication-gate totals now use one scan per current-release
set. The metadata response reuses the freshly validated document/paragraph
counts within the same request. Every request retains live release, manifest,
state and corpus integrity checks; there is no cached acceptance or new job.
Public assets, corpus, citations, authentication and retired OCR stay intact.

Validation: TypeScript, build, 63 focused Node 24 tests, strict dry-run,
exact-source secret scan, isolated candidate bundle parity, 83 public assets,
API and desktop/mobile acceptance. Initial raw metadata hash mismatches were
not payload-captured; their exact cause remains unknown. Bounded same-path
comparison of predecessor, candidate and production then proved every nested
value identical. Do not characterize the initial mismatch as a proven
serialization issue or use it to justify unbounded rechecking.

The central release authority stores the exact acceptance and rollback
receipts. Public maintenance record: `curriculum-reduce-repeated-reads-20261007`;
the registered publisher, immutable API, public page and both RSS views passed.
No further provider/OCR calls are authorized by this checkpoint. The dated
records below are history where superseded by this current state.

# Project State

Last updated: 2026-08-29 PDT
Current version: GitHub main `31f9dfb`; production Worker `806c690c-e31a-419e-94d2-796e9f5e4bbc` at 100 percent, preview Worker unchanged at `3c6f19e3-51b6-456f-9258-b09671d4d2cf`
Current objective: preserve the completed public product and frozen evidence while using one server-only APIS caller identity in production and keeping preview AI fail closed
Completed work: production AI requires the Cloudflare secret `APIS_CALLER_TOKEN` and sends caller `curriculum-atlas`; preview sets `APIS_ENABLED=false` and rejects before retrieval. PR #1 added the typed no-provider handler and PR #4 added `/__caller-check` to the top-level Static Assets `run_worker_first` list without changing preview. Exact Node 24.18.0 TypeScript, 37/37 backend tests, deterministic build, strict production dry-run, exact-commit gitleaks and the clean-source deploy gate passed. Candidate `806c690c-e31a-419e-94d2-796e9f5e4bbc` returned HTTP 200 JSON with verified identity at 0%, 1%, 5% and 100%; the full repeatable caller table reached 24/27 after this release. Preview and the 2026-08-12 OCR retirement remained unchanged.
Pending work: no caller-route work remains for this project. After APIS caller-auth is separately authorized and staged, rerun the full table. No OCR continuation is authorized.
Known problems: the legacy full `npm run verify` still expects removed `.cache/ocr-production/*/state.json` from the formally retired OCR runtime and therefore fails before code checks. The APIS change instead passed TypeScript, 37/37 backend integrity tests, build, strict Worker dry-run and commit-scoped gitleaks; this stale gate must be repaired only in a separately scoped verification-standard update.
Next recommended task: separately align the retired-OCR verification gate without restoring or synthesizing retired hot state; do not combine that governance repair with APIS enforcement.
Deployment status: production deployment `d5574ab0-a6f0-4d90-ad7f-df5e71bf2538` runs `806c690c-e31a-419e-94d2-796e9f5e4bbc` at 100%; preview deployment `fc259ebe-2ba0-40b9-8e5e-493d4c270eb4` remains `3c6f19e3-51b6-456f-9258-b09671d4d2cf` at 100%.
Rollback anchor: restore production `104ccefa-baf0-4c96-ae4b-8c1c4e25dc38` at 100%; preview was not changed. Do not reset D1/R2 or restart retired OCR.
Operations authority: /Users/ylsuen/CF/curriculum-atlas/docs/OPERATIONS.md
Ownership status: APIS migration is owned by task `20260827-apis-caller-auth-containment`; consult reports/agent_action_log.jsonl

2026-08-30 Turnstile closeout: anonymous comments remain fresh-token-per-write
with exact `curriculum_comment` action/hostname and fail-closed Siteverify.
Production source `ab5ef83efcb739461738a0e905eb949e06b62266` is deployment
`1108163c-f95b-4d8b-afcd-a3941253f5f1`, version
`c7259ead-9cf9-4f93-94db-dfeba4b9520e` at 100%. Health returned `ok:true`;
preview remained unchanged. Rollback is
`806c690c-e31a-419e-94d2-796e9f5e4bbc@100%`.

## 2026-09-20 query-cost release

Production source `b74659c742e692c07f5205fdb3c0dc67ba17f3a4` is deployment
`411fa14b-f7c4-465a-9e57-9404b7578ded`, Worker
`09832541-e347-4fab-b64e-8b2072010c80` at100%. Rollback is
`c7259ead-9cf9-4f93-94db-dfeba4b9520e`; use a new registered rollback receipt,
never replay the consumed release receipt. No D1/R2 migration or data write.

Unknown/wrong-method API routes return404 before corpus/session reads. Valid
routes keep live corpus integrity and citation/authentication gates. Eligible
fallback searches use existing trigram LIKE; fewer than3 Unicode characters
or backslash/percent/underscore/NUL keep the original fallback semantics.
The original MATCH path and ranking are unchanged.

Read-only production evidence: no-result long searches16501→1 row; 核心素养
fallback20616→6860; a subject-filtered case17873→4117. Six before/after
queries had identical full returned rows and order;16500-row FTS projection
matched paragraphs. Two-character and special-character queries remain costly.
Valid requests still perform full corpus integrity counts; this is no account
spending cap.75 focused backend/security/retrieval tests, TypeScript, build,
strict pinned-Wrangler dry run and exact-commit gitleaks passed.

Validation for this runtime-only release compared all unchanged public assets,
source/migration/config hashes and live corpus counts instead of rebuilding
retired OCR state. Legacy full verify still requires deleted OCR hot state and
was not claimed passed or restored. Immutable isolated preview and production
candidate bundles were byte-identical;83 public assets and13 HTTP cases passed
in preview and production. Cross-environment paragraph primary keys differ;
all other search fields and ordering matched exactly. Production before/after
results also matched including IDs.1440×1000/390×844 browser checks passed.
Production preview URLs stayed disabled; isolated preview's active deployment
was unchanged. Exact evidence: `/Users/ylsuen/CF/reports/operations/cloudflare-risk-atlas-20260920/REPORT.md`.
