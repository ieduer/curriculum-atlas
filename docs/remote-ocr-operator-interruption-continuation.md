# A2 operator-interrupted attempt 6 forward continuation

This procedure covers one incident only: the already granted A2 attempt 6 for
`legacy-compendium-english` was healthy and making progress, but the operator stopped its worker
after a monitor-result `jq` query used a nonexistent path. It is not another timeout recovery and
does not authorize another OCR attempt.

## Why the existing runner must remain unchanged

The committed A2 seed identity pins `scripts/run-remote-ocr-offload.mjs` to SHA-256
`0fbf3d284f324f5faa710ca09342cdef88d24e6349b6e5d590ccca215065354d`. Editing that runner would
make its own committed-seed identity check fail. Overriding that hash would falsely present changed
code as the original runner. Rolling `attempts` back to 5 would erase the fact that attempt 6 really
started. Neither action is allowed.

`scripts/continue-remote-ocr-operator-interruption.mjs` is therefore a separate, one-shot runner. On
apply it first asks the byte-identical base runner to verify the complete committed seed and live
runtime. It then takes the same `.remote-ocr-orchestrator.lock`, rechecks every incident anchor,
publishes a separate authorization receipt and atomic consumption claim, and invokes the same OCR
entrypoint without incrementing attempt 6. A successful continuation writes the ordinary attempt-6
completion schema, after which the unchanged base runner can resume the remaining documents.

## Frozen incident

These values are not discovery defaults. They are the exact authorization boundary for this A2
incident:

| Anchor | Exact value |
| --- | --- |
| document | `legacy-compendium-english` |
| granted attempt / ceiling | `6 / 6` |
| original worker InvocationID | `cea41604c79f46cfa9483b46d64ad0fd` |
| operator interruption time | `2026-07-22T04:13:35.390Z` |
| output device / inode | `66306 / 45748776` |
| interrupted `run-status.json` SHA-256 | `1daf1ab535d8378c25625591494acd1e7922266873e48821e46be9ff04ddbe1b` |
| interrupted document status SHA-256 | `28921af43e57ffd2e1443a2b03a2261075557e3dfd9a732cedc5ff4b4848c63a` |
| append-only log SHA-256 / bytes | `470d7b4ef6be1ff3363e44c6e320d0b6d062196069f1205a679eac9b466662d2 / 11585` |
| state SHA-256 | `d16de657043c260136552cd8cf881791f42308169e2ecf55fe0cab5f155aa09d` |
| document tree SHA-256 / files / bytes | `0ecee6008bc62def2fbaaa701ea9161b72a06b739dddc7e6fe72ff8963d23265 / 579 / 7100211` |
| immutable base runner SHA-256 | `0fbf3d284f324f5faa710ca09342cdef88d24e6349b6e5d590ccca215065354d` |
| operator incident evidence root | `.../a2-deploy-evidence/20260719T003812Z/incident-operator-freeze-monitor-jq-20260722T041335Z` |

The interrupted entry must be the English document. `legacy-compendium-geography` remains a normal
`retry_wait` document at inherited attempt 5 and must not appear in this continuation receipt.

Before staging, read and freeze the incident evidence tree SHA-256 and the existing root-level
`timeout-recovery-grant.json` and `timeout-recovery-consumption-claim.json` SHA-256 values. The tool
requires all three. It verifies that exactly one entry for the English document exists in the grant
and consumption claim, that both authorize attempt 6 from inherited attempt 5, and that the claim is
bound to output inode `45748776` and the committed seed ID.

## Non-negotiable gates

- Keep the worker, monitor timer, notifier, and any prior repair process stopped and process-free.
- Start only the already attested `curriculum-ocr-llama.service` before the live runtime gate. Do not
  query or start the obsolete `llama-server.service`.
- Do not restore any of the four pre-inference repair files. Their old bytes describe the earlier
  pre-inference incident and are no longer the current state.
- Do not create, copy, reconstruct, or republish a timeout grant, issuance, authority, or timeout
  consumption claim.
- Do not change `attempts` from 6 to 5 and do not authorize attempt 7.
- Do not truncate or replace the English document log or document tree. The OCR child appends to the
  existing log and may only add missing-page artifacts plus update `state.json`.
- Do not run the ordinary worker after a continuation claim exists unless the continuation finished
  and the English document is an exact, validated `complete` at attempt 6.
- Completion here remains `citation_allowed=false`. It is OCR staging evidence, not publication.

## Stage and verify the sealed runtime

Create a new content-addressed runtime; do not edit the sealed monitor or earlier repair runtime.
Include:

- `scripts/continue-remote-ocr-operator-interruption.mjs`
- the byte-identical `scripts/run-remote-ocr-offload.mjs`
- the byte-identical `scripts/ocr-pdf-paddle.py`
- `scripts/lib/remote-ocr-local-snapshot.mjs`

Write an absolute-path `SHA256SUMS`, set directories to `0500`, files to `0400`, and record the source
commit. Verify the base runner separately:

```bash
sha256sum scripts/run-remote-ocr-offload.mjs
# must equal 0fbf3d284f324f5faa710ca09342cdef88d24e6349b6e5d590ccca215065354d
```

Run the focused Linux suite from the sealed runtime before touching A2:

```bash
node --test tests/remote-ocr-operator-interruption-continuation.test.mjs
```

## Build the exact command once

Take the original A2 worker's OCR/runtime options from the verified effective systemd unit. Do not
retype or infer them. Set `AUTHORIZED_AT` and `CONTINUED_AT` once as canonical UTC millisecond
timestamps and reuse the same values for both previews and apply. Fill only the three read-only
anchors shown as placeholders below.

```bash
CONTINUATION=(
  node <SEALED_RUNTIME>/scripts/continue-remote-ocr-operator-interruption.mjs
  <EXACT_ORIGINAL_A2_MANIFEST_INPUT_RUNTIME_AND_MONITORING_OPTIONS>
  --document-id legacy-compendium-english
  --attempt 6
  --worker-invocation-id cea41604c79f46cfa9483b46d64ad0fd
  --operator-interrupted-at 2026-07-22T04:13:35.390Z
  --authorized-at "<AUTHORIZED_AT>"
  --continued-at "<CONTINUED_AT>"
  --incident-evidence-root "<EXACT_INCIDENT_EVIDENCE_ROOT>"
  --expected-output-device 66306
  --expected-output-inode 45748776
  --expected-run-status-sha256 1daf1ab535d8378c25625591494acd1e7922266873e48821e46be9ff04ddbe1b
  --expected-status-sha256 28921af43e57ffd2e1443a2b03a2261075557e3dfd9a732cedc5ff4b4848c63a
  --expected-log-sha256 470d7b4ef6be1ff3363e44c6e320d0b6d062196069f1205a679eac9b466662d2
  --expected-log-bytes 11585
  --expected-state-sha256 d16de657043c260136552cd8cf881791f42308169e2ecf55fe0cab5f155aa09d
  --expected-document-tree-sha256 0ecee6008bc62def2fbaaa701ea9161b72a06b739dddc7e6fe72ff8963d23265
  --expected-document-tree-files 579
  --expected-document-tree-bytes 7100211
  --expected-incident-tree-sha256 "<INCIDENT_EVIDENCE_TREE_SHA256>"
  --expected-grant-sha256 "<EXISTING_GRANT_SHA256>"
  --expected-consumption-claim-sha256 "<EXISTING_CONSUMPTION_CLAIM_SHA256>"
  --expected-runner-script-sha256 0fbf3d284f324f5faa710ca09342cdef88d24e6349b6e5d590ccca215065354d
)
```

The exact original options must still resolve to p1, micro-batch 16, queues enabled, loopback
`127.0.0.1:8112/v1`, startup 180 seconds, idle 1200 seconds, wall floor 1200 seconds, 25 seconds per
page, termination grace 15 seconds, and poll interval 5 seconds. Any difference is rejected.

## Preview twice, then apply once

Two previews must be byte-identical and leave the output tree byte inventory unchanged:

```bash
"${CONTINUATION[@]}" >preview-1.json
"${CONTINUATION[@]}" >preview-2.json
cmp preview-1.json preview-2.json
sha256sum preview-1.json preview-2.json
```

Both must return `status=ready`, `attempt=6`, `citation_allowed=false`, the same continuation ID,
and the same future receipt/claim paths. No `operator-continuations` directory may exist afterward.

Run apply once from a bounded user systemd unit so that SSH loss does not become another operator
signal. Preserve the transient unit's journal and InvocationID with the evidence bundle:

```bash
"${CONTINUATION[@]}" --apply
```

Apply first runs the unchanged base runner's full committed-seed/live-runtime gate. Under the shared
orchestrator lock it then creates:

```text
operator-continuations/legacy-compendium-english/attempt-0006/
  interrupted-run-status.json{,.sha256}
  interrupted-status.json{,.sha256}
  interrupted-state.json{,.sha256}
  pre-continuation.log{,.sha256}
  receipt.json{,.sha256}
  claim.json{,.sha256}
```

Directories are owner-only `0700`; files are owner-only, single-link `0600`. The archived files are
the exact pre-continuation bytes. The claim is written with no replacement immediately before OCR
spawn. A second apply always fails as already consumed.

## Success verification

Require all of the following before returning ownership to the ordinary worker:

1. continuation exits `0` and returns `status=complete`, `attempt=6`;
2. receipt and claim sidecars verify, modes are exact, and their IDs bind each other;
3. English progress and document status are both `complete`, attempt/max `6/6`;
4. English original `started_at` is retained; no new attempt timestamp replaced it;
5. the archived interrupted progress/status still say attempt 6, `SIGTERM`, and
   `2026-07-22T04:13:35.390Z`;
6. the live log begins byte-for-byte with archived `pre-continuation.log` and is not shorter;
7. every pre-existing document-tree file except `state.json` is byte-identical; only missing-page
   artifacts were added;
8. completed output passes the ordinary whole-document validator;
9. grant, issuance, timeout consumption claim, seed receipt, and old repair evidence retain their
   pre-continuation hashes;
10. no attempt 7, new timeout grant, new timeout authority claim, or attempt reset exists.

Then restore/start the unchanged ordinary A2 worker and run two separate monitor canaries. The first
ordinary runner pass must recognize English as complete without invoking it and may continue only
the other three `retry_wait` documents.

## Failure and rollback boundary

This protocol is forward-only. There is no rollback to the pre-continuation status files.

- Before `claim.json` exists: stop, preserve the receipt if already published, fix only the staged
  runtime or command, and rerun the same exact authorization.
- After `claim.json` exists: never delete or replace the claim and never run apply again.
- A second operator stop returns exit `75` and leaves attempt 6 interrupted with the claim consumed.
- A content failure returns exit `12` and quarantines attempt 6.
- A shared runtime failure returns exit `2`, records `failure_class=shared_runtime_configuration`,
  and keeps attempts at 6. It does not release the attempt back to 5.
- Any control, inode, hash, log length, page tree, seed, grant, claim, runtime, or runner drift fails
  closed before the continuation claim whenever possible.

After any non-success outcome, keep every unit held and archive the complete continuation directory,
journal, current run/status/log/state hashes, and process-free proof for a new review. Do not start
the ordinary runner merely to force a terminal status.

The receiver/import path must not publish this document until it also archives and validates the
operator-continuation receipt and claim. OCR completion alone remains non-citable staging.
