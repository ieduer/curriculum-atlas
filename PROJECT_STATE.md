# Project State

Last updated: 2026-08-28 PDT
Current version: GitHub/local main `d1568222d6998d36644d56be0c70fe7a02aed489`; production Worker `104ccefa-baf0-4c96-ae4b-8c1c4e25dc38`, preview Worker `3c6f19e3-51b6-456f-9258-b09671d4d2cf`
Current objective: preserve the completed public product and frozen evidence while using one server-only APIS caller identity in production and keeping preview AI fail closed
Completed work: production AI now requires the Cloudflare secret `APIS_CALLER_TOKEN` and sends caller `curriculum-atlas`; preview sets `APIS_ENABLED=false` and rejects before retrieval. Production and preview health read back release Git `d156822…` with the existing corpus and all five bindings ready. The 2026-08-12 OCR retirement remains unchanged.
Pending work: the shared APIS transaction must enroll the recorded SHA-256 digest and obtain one product-path verified request before gateway enforce; no OCR continuation is authorized
Known problems: the legacy full `npm run verify` still expects removed `.cache/ocr-production/*/state.json` from the formally retired OCR runtime and therefore fails before code checks. The APIS change instead passed TypeScript, 34/34 backend integrity tests, build, strict Worker dry-run and commit-scoped gitleaks; this stale gate must be repaired only in a separately scoped verification-standard update.
Next recommended task: complete the shared APIS registry/enforce acceptance, then separately align the retired-OCR verification gate without restoring or synthesizing retired hot state
Deployment status: production deployment `5b5ed424-b184-4b5e-95ea-b978207b21a9` runs `104ccefa…` at 100%; preview deployment `fc259ebe-2ba0-40b9-8e5e-493d4c270eb4` runs `3c6f19e3…` at 100%
Rollback anchor: restore production `c6fa8f68-747e-4d65-a743-2498ab2e0591` or preview `fdc9b9f2-7698-47b6-9663-44475786de34` at 100%; do not reset D1/R2 or restart retired OCR
Operations authority: /Users/ylsuen/CF/curriculum-atlas/docs/OPERATIONS.md
Ownership status: APIS migration is owned by task `20260827-apis-caller-auth-containment`; consult reports/agent_action_log.jsonl
