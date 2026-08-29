# Project State

Last updated: 2026-08-29 PDT
Current version: GitHub/local main `0f8763b`; production Worker deliberately restored to `104ccefa-baf0-4c96-ae4b-8c1c4e25dc38`, preview Worker unchanged at `3c6f19e3-51b6-456f-9258-b09671d4d2cf`
Current objective: preserve the completed public product and frozen evidence while using one server-only APIS caller identity in production and keeping preview AI fail closed
Completed work: production AI requires the Cloudflare secret `APIS_CALLER_TOKEN` and sends caller `curriculum-atlas`; preview sets `APIS_ENABLED=false` and rejects before retrieval. PR #1 added a tested no-provider caller handler and preview-safe 503 behavior. Node 24 TypeScript, 37/37 backend tests, deterministic build, strict production dry-run and exact-commit gitleaks passed. Candidate `11555d36-e0cf-46d7-b991-bad793668cce` was attached at 0%, but its exact probe returned the SPA HTML fallback because `assets.run_worker_first` still contains only `/api/*`; D20 therefore restored production immediately. Preview and the 2026-08-12 OCR retirement remained unchanged.
Pending work: under new explicit authority, add `/__caller-check` to the production source's `assets.run_worker_first` routing and rerun the staged release. The handler is in main but is not reachable in production. No OCR continuation is authorized.
Known problems: the legacy full `npm run verify` still expects removed `.cache/ocr-production/*/state.json` from the formally retired OCR runtime and therefore fails before code checks. The APIS change instead passed TypeScript, 34/34 backend integrity tests, build, strict Worker dry-run and commit-scoped gitleaks; this stale gate must be repaired only in a separately scoped verification-standard update.
Next recommended task: resolve the source/runtime routing mismatch above as a separately authorized retry; then separately align the retired-OCR verification gate without restoring or synthesizing retired hot state.
Deployment status: rollback deployment `b05cc96f-30ae-4b04-b652-a1f053314163` runs production `104ccefa…` at 100%; preview deployment `fc259ebe-2ba0-40b9-8e5e-493d4c270eb4` remains `3c6f19e3…` at 100%.
Rollback anchor: restore production `c6fa8f68-747e-4d65-a743-2498ab2e0591` or preview `fdc9b9f2-7698-47b6-9663-44475786de34` at 100%; do not reset D1/R2 or restart retired OCR
Operations authority: /Users/ylsuen/CF/curriculum-atlas/docs/OPERATIONS.md
Ownership status: APIS migration is owned by task `20260827-apis-caller-auth-containment`; consult reports/agent_action_log.jsonl
