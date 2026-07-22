# A2 pre-inference interruption rearm

This runbook covers one incident only: `legacy-compendium-english` consumed the
already-issued attempt-6 launch, then the externally initiated Step-8 freeze sent
`SIGTERM` before the OCR child changed a page artifact or `state.json`. It does
not issue, copy, or extend timeout-recovery authority. It restores the four
mutable controls to the exact attempt-5 `retry_wait` bytes produced by the
committed seed transaction.

The repair program is hard-bound to the frozen output inode, worker invocation,
timestamps, run/status/log/state hashes, paths, and five systemd units. Supplying
a different incident fails before filesystem inspection. The full document-tree
hash is supplied at invocation but must also equal the immutable seed receipt.

## Safety boundary

- Target: DMITPro2 inner `bdfz` workstation, A2 output only.
- Output root inode: `45748776`; recreation, copying, or a different mount is
  rejected by both the program and the existing consumption claim.
- Required state: worker, monitor, and alert handler have `MainPID=0`; the two
  timers expose the real four-property timer schema with an empty
  `InvocationID`. Every unit has `ActiveState=inactive` or `failed`. `failed` is
  accepted only as a process-free systemd state; active/activating/reloading or
  deactivating is rejected.
- Lock: the program obtains the existing `.a2-lifecycle.lock` with nonblocking
  `flock` before reading units or controls and holds it through verification and
  replacement.
- Evidence: an owner-only `0700` transaction directory is created below the
  existing A2 deployment evidence root, which is disjoint from the output root.
- Resume gate: a deterministic fingerprint covers every output directory and
  file except the four receipt-bound transaction members and their four exact
  deterministic temporary names. Any unrelated page, state, status, log,
  cache, or control drift is rejected before another replacement.
- Publication: `citation_allowed` remains `false`; no OCR or web publication
  gate changes.
- Explicit exclusions: no SSH action is performed by the program; it does not
  start, stop, enable, disable, reset, or edit a systemd unit; it does not edit
  the sealed A2 workspace, runner, monitor, seed receipt, seed commit, grant,
  issuance, ledger, claim, state, page, or log.

## Why this is not a seventh attempt

The archived predecessor `run-status.json` is reread from
`seed-predecessor-evidence` and verified through the existing B1/B2 inspectors.
For the target only, the program repeats the original seed transformation:

1. clone the immutable quarantined attempt-5 predecessor progress;
2. add `predecessor_status`, `inherited_attempts`, and `seed_id`;
3. set `status=retry_wait`, `next_retry_at=quarantined_at`, and
   `attempt_ceiling=6`;
4. bind the existing grant id/hash and first missing page;
5. delete only `quarantined_at` and `quarantine_reason`;
6. reconstruct the exact seed successor status and require its SHA-256 to equal
   `seed-receipt.json#documents[].successor_status_sha256`.

The current attempt-6 interruption must exactly equal the result of launching
that seed progress once and stopping it with the frozen `SIGTERM` timestamps.
Extra fields fail. Other documents are cloned from the current run status and
must remain unchanged. Counts, `finished`, and `settled` are recomputed, and
`updated_at` is set to one operator-frozen canonical timestamp.

## Immutable incident anchors

The executable contains and checks these values; the repeated CLI values make
the operator transcript independently auditable.

```text
document                    legacy-compendium-english
worker invocation           0916aeada09b4f38bb7b4b17b6063712
worker exit status          75
started_at                  2026-07-22T02:32:45.088Z
interrupted_at              2026-07-22T02:32:47.128Z
current run-status SHA-256  1efe426705557843ee0023abf556890e8df2a4052cef13d82e9e7d04111c98e7
current status SHA-256      3cf110083dc94c6d5bf9eebd4c42ab8243eb9a8528abccac9dc27d56a6bde6cb
current log                 1189 bytes
current log SHA-256         2a55211f63eac4f946d19d2c2c4309b4da8c6db65834f62268f0f0fd10ba6c6a
current state SHA-256       d16de657043c260136552cd8cf881791f42308169e2ecf55fe0cab5f155aa09d
```

The exact document-tree SHA-256 is intentionally read from the immutable seed
receipt at execution time and compared again by the program. Do not type a
truncated hash.

## Operator procedure

Connect through the documented two-hop path, then set the exact paths. Do not
place a password, token, cookie, or private key in the command transcript.

```bash
set -euo pipefail
RUN_ROOT=/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess
OUTPUT_ROOT="$RUN_ROOT/output/production-p1-mb16-shard-a-r2"
PREDECESSOR_ROOT="$RUN_ROOT/output/production-p4-mb16-shard-a-r1"
EVIDENCE_ROOT="$RUN_ROOT/a2-deploy-evidence/20260719T003812Z"
LIFECYCLE_LOCK="$RUN_ROOT/.a2-lifecycle.lock"
REPAIR_SCRIPT="$RUN_ROOT/repair-runtime/repair-remote-ocr-preinference-interruption.mjs"
DOCUMENT=legacy-compendium-english

test "$(stat -c %i "$OUTPUT_ROOT")" = 45748776
test -d "$EVIDENCE_ROOT"
test ! -L "$EVIDENCE_ROOT"
DOCUMENT_TREE_SHA256="$(jq -er \
  --arg id "$DOCUMENT" \
  '.documents[] | select(.document_id == $id) | .successor_document_tree.tree_sha256' \
  "$OUTPUT_ROOT/seed-receipt.json")"
test "${#DOCUMENT_TREE_SHA256}" = 64

# Freeze this once. Reuse the same value for both previews and apply.
REPAIR_AT="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
```

Before invoking the program, independently confirm all five units are
process-free. Do not reset the failed worker or alert handler yet because their
invocation evidence is still required.

```bash
systemctl --user show \
  curriculum-ocr-reprocess-a-r2.service \
  curriculum-ocr-reprocess-a-r2-monitor.service \
  curriculum-ocr-reprocess-a-r2-monitor.timer \
  curriculum-ocr-monitor-alert-retry@curriculum-ocr-reprocess-a-r2-monitor.service.timer \
  curriculum-ocr-monitor-alert@curriculum-ocr-reprocess-a-r2-monitor.service.service \
  --property=Id --property=LoadState --property=ActiveState --property=SubState \
  --property=MainPID --property=InvocationID --property=ExecMainStatus --no-pager
```

Build one shell array so every invocation is byte-for-byte equivalent.

```bash
REPAIR=(
  node "$REPAIR_SCRIPT"
  --output-root "$OUTPUT_ROOT"
  --predecessor-root "$PREDECESSOR_ROOT"
  --evidence-root "$EVIDENCE_ROOT"
  --lifecycle-lock "$LIFECYCLE_LOCK"
  --document-id "$DOCUMENT"
  --worker-unit curriculum-ocr-reprocess-a-r2.service
  --monitor-unit curriculum-ocr-reprocess-a-r2-monitor.service
  --monitor-timer-unit curriculum-ocr-reprocess-a-r2-monitor.timer
  --retry-timer-unit curriculum-ocr-monitor-alert-retry@curriculum-ocr-reprocess-a-r2-monitor.service.timer
  --alert-unit curriculum-ocr-monitor-alert@curriculum-ocr-reprocess-a-r2-monitor.service.service
  --expected-output-inode 45748776
  --expected-worker-invocation-id 0916aeada09b4f38bb7b4b17b6063712
  --expected-started-at 2026-07-22T02:32:45.088Z
  --expected-interrupted-at 2026-07-22T02:32:47.128Z
  --repair-at "$REPAIR_AT"
  --expected-run-status-sha256 1efe426705557843ee0023abf556890e8df2a4052cef13d82e9e7d04111c98e7
  --expected-document-status-sha256 3cf110083dc94c6d5bf9eebd4c42ab8243eb9a8528abccac9dc27d56a6bde6cb
  --expected-log-sha256 2a55211f63eac4f946d19d2c2c4309b4da8c6db65834f62268f0f0fd10ba6c6a
  --expected-log-bytes 1189
  --expected-state-sha256 d16de657043c260136552cd8cf881791f42308169e2ecf55fe0cab5f155aa09d
  --expected-document-tree-sha256 "$DOCUMENT_TREE_SHA256"
)
```

Run two mutation-free previews and require identical output.

```bash
"${REPAIR[@]}" > /tmp/a2-preinfer-rearm-preview-1.json
"${REPAIR[@]}" > /tmp/a2-preinfer-rearm-preview-2.json
cmp /tmp/a2-preinfer-rearm-preview-1.json /tmp/a2-preinfer-rearm-preview-2.json
jq -e '.valid == true and .mode == "dry_run" and .state == "ready" and
  .attempt == 5 and .status == "retry_wait" and .citation_allowed == false' \
  /tmp/a2-preinfer-rearm-preview-1.json
```

Apply exactly once, then invoke the same apply a second time. The first must say
`applied` with four replacements; the second must say `already_applied` with
zero replacements.

```bash
"${REPAIR[@]}" --apply > /tmp/a2-preinfer-rearm-apply.json
jq -e '.valid == true and .mode == "apply" and .state == "applied" and
  .replacements == 4 and .attempt == 5 and .status == "retry_wait" and
  .citation_allowed == false' /tmp/a2-preinfer-rearm-apply.json

"${REPAIR[@]}" --apply > /tmp/a2-preinfer-rearm-idempotent.json
jq -e '.valid == true and .state == "already_applied" and .replacements == 0' \
  /tmp/a2-preinfer-rearm-idempotent.json
```

Do not start the worker in the same shell block. Hand the receipt path and exact
hashes to the A2 Step-8 operator, who must first install the separately reviewed
monitor runtime overlay and rerun the two monitor canaries.

## Evidence and transaction state machine

The program publishes `<EVIDENCE_ROOT>/<repair_id>/` with mode `0700`. All files
inside are mode `0600`:

- `before/run-status.json` and sidecar;
- `before/status/legacy-compendium-english.json` and sidecar;
- the exact 1189-byte `before/logs/legacy-compendium-english.log`;
- `before/documents/legacy-compendium-english/state.json`;
- the four exact `after/` controls;
- `controls.json`, containing hashes for seed receipt, commit marker, journal,
  run identity, grant, ledger, claim, issuance, predecessor-evidence tree, and
  the exact output-root inventory;
- `repair-receipt.json` and its SHA-256 sidecar.

An owner-only sibling `<repair_id>.claim.json` reserves the evidence basename
with no-replace creation before the directory is published. A different or
missing reservation makes a pre-existing directory a collision, never a resume.
Every evidence file is fsynced, then every created nested directory is fsynced
bottom-up before the staging directory is renamed and the evidence root is
fsynced.

Only these output paths are replaceable, in order:

```text
status/legacy-compendium-english.json
status/legacy-compendium-english.json.sha256
run-status.json
run-status.json.sha256
```

Before every replacement, the current file must equal either its receipt-bound
`before` bytes or its receipt-bound `after` bytes. A crash can therefore leave a
mixed state; rerunning the identical `--apply` completes only remaining `before`
members. A third byte state, changed evidence, an unexpected temporary file, or
a pre-existing different evidence directory fails closed.

An existing receipt is never accepted merely because its own hashes agree. The
program revalidates the frozen pre-interruption bytes, reconstructs the exact
attempt-5 status from the immutable seed controls, regenerates all four after
files, units, artifacts, transaction rows, and receipt bytes, and requires the
stored evidence to match that reconstructed plan byte for byte before it may
classify or replace a mutable output file.

## Verification standard

The repair is acceptable only when all checks pass:

1. both dry-run JSON files are identical;
2. evidence readback and receipt sidecar validate;
3. first apply reports four replacements and second apply reports zero;
4. target progress is `retry_wait`, `attempts=5`, `attempt_ceiling=6`, and retains
   the original grant id/hash and first missing page;
5. run counts are `complete=4`, `retry_wait=4`, `interrupted=0`, with
   `citation_allowed=false`;
6. target status hash again equals the seed receipt successor-status hash;
7. page tree, state SHA-256, and live log SHA-256/bytes remain unchanged;
8. grant, issuance, and consumption claim counts remain exactly one and their
   hashes match `controls.json`;
9. the existing full B1/B2 inspectors pass after all four replacements;
10. no unit was started, enabled, reset, or edited by this procedure.

The checked-in test suite contains a Linux-only inherited-file-descriptor
`flock` test and an opt-in, mutation-free production boundary test that uses the
real five `systemd --user` units plus the full B1/B2 inspectors. Run it on the
frozen inner workstation only after placing the reviewed script and test in a
private runtime directory; it performs dry-run twice and byte-compares all four
mutable controls:

```bash
CURRICULUM_A2_REAL_INTEGRATION=1 \
CURRICULUM_A2_REPAIR_AT="$REPAIR_AT" \
node --test tests/remote-ocr-preinference-interruption-repair.test.mjs
```

The two Linux integration cases are reported as skipped on macOS. A macOS-only
green result therefore does not substitute for this pre-apply Linux gate.

## Rollback

Before a worker restart, rollback means restoring the four `before/` files from
the receipt-bound evidence under the same lifecycle flock, then verifying both
sidecars and the frozen run/status hashes. Keep all five units process-free.
Never restore only one member of a JSON/sidecar pair.

After the worker has restarted or written any new page, state, status, or log
bytes, the four-file rollback is forbidden: it would discard new evidence and
break the attempt ledger. Freeze the units, preserve the new incident, and open
a separate reviewed protocol instead. The repair receipt, grant, claim, seed,
and original 1189-byte log are immutable evidence and must not be deleted.
