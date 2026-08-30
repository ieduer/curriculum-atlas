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
