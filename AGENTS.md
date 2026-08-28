# AGENTS.md for /Users/ylsuen/CF/curriculum-atlas

## Project scope

Project: curriculum-atlas

This project inherits `/Users/ylsuen/CF/AGENTS.md`. Read, in order:

1. the workspace instructions and project matrix;
2. `/Users/ylsuen/CF/reports/operations/INDEX.md` and resource/handbook indexes;
3. this file;
4. `docs/OPERATIONS.md`;
5. `PROJECT_STATE.md`;
6. target source/config/tests and the narrowest fresh live readback.

## Operating constraints

- Canonical local root: `/Users/ylsuen/CF/curriculum-atlas`.
- Treat unresolved lifecycle, source, runtime, data, and rollback facts as `review_required` and fail closed.
- Preserve unrelated dirty work and active task ownership.
- Do not create parallel identity, Gemini key pools, analytics, registries, or content authority.
- Shared-hub, student-data, App, clone-family, public registration, Cloudflare, VPS, archive, and security gates from the workspace remain mandatory.
- No production mutation follows from a generated inventory or historical report.
- The local automatic OCR lifecycle was formally retired on 2026-08-12 at the
  user's direction. Do not reinstall or bootstrap
  `com.suen.curriculum-ocr-watchdog`, start `ocr-watchdog.mjs run`, release the
  held queue, or resume the 4,900 pending pages without a new explicit
  authorization and a fresh source/evidence/retention review. Existing OCR
  sources, completed evidence, quarantine records, and private archives remain
  preserved and fail closed.

## Documentation and handoff gate

Before mutation append a scoped action-log `start`. Record changes and executable verification. Update `docs/OPERATIONS.md` in the same task when an operational fact changes, and update `PROJECT_STATE.md` when current state changes. Closeout must include exact files, artifacts, tests, live version, rollback, dirty-tree state, unresolved items, and documentation updates. Chat is not a handoff authority.
