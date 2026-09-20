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
