# A2 operator-interrupted attempt 6 forward continuation

This procedure is for one incident only: `legacy-compendium-english`, already-consumed attempt 6,
was stopped by the operator after an observer-side `jq` mistake. It does not create another timeout
grant, reset the attempt count, or authorize attempt 7.

## Current release gate: anchors pinned, execution still blocked

The executable owns the incident profile in
`scripts/lib/remote-ocr-operator-continuation.mjs`. Incident identity is not accepted from CLI flags.
An independently verified, bounded, read-only collection pinned the remaining values in the
candidate profile:

- operator-freeze evidence tree SHA-256:
  `ecad58b65032556b52e274055bde314aa479f58ab19d54bd9c861b1681e5d2c6`;
- A2 rearm `repair-receipt.json`: 7,691 bytes, SHA-256
  `05c7d6fae0551ba22527c3353e112fc1ec9bce083f2a627537c089ce76754706`;
- A2 rearm reservation-claim SHA-256:
  `91c7433f7169b369c3f980140a0ca8d32db7c83d88d34a15894af229b1ff610b`;
- A2 rearm evidence tree SHA-256:
  `a758aa84cff692c952ce2d0eae8db5c136d1c35c440710981319f534508e86d6`.

Do not substitute values from an operator command, a copied tree, or the unrelated `22eae7d9...`
r5 repair. Pinning these anchors does not authorize execution. The exact pin commit still requires
independent review, the three Linux-only ownership/lock tests, two byte-identical live dry runs, and
a bounded same-attempt canary before the frozen worker may resume.

## Frozen identity already recovered

| Anchor | Exact value |
| --- | --- |
| run root | `/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess` |
| output root | `.../output/production-p1-mb16-shard-a-r2` |
| output device / inode | `66306 / 45748776` |
| lifecycle lock / inode | `.a2-lifecycle.lock / 41590544` |
| evidence base inode | `42336296` |
| operator-freeze evidence inode | `42336297` |
| document / attempt | `legacy-compendium-english / 6` |
| worker InvocationID | `cea41604c79f46cfa9483b46d64ad0fd` |
| interrupted at | `2026-07-22T04:13:35.390Z` |
| run-status SHA-256 | `1daf1ab535d8378c25625591494acd1e7922266873e48821e46be9ff04ddbe1b` |
| document-status SHA-256 | `28921af43e57ffd2e1443a2b03a2261075557e3dfd9a732cedc5ff4b4848c63a` |
| log SHA-256 / bytes | `470d7b4ef6be1ff3363e44c6e320d0b6d062196069f1205a679eac9b466662d2 / 11585` |
| state SHA-256 | `d16de657043c260136552cd8cf881791f42308169e2ecf55fe0cab5f155aa09d` |
| document tree SHA-256 / files / bytes | `0ecee6008bc62def2fbaaa701ea9161b72a06b739dddc7e6fe72ff8963d23265 / 579 / 7100211` |
| immutable base runner SHA-256 | `0fbf3d284f324f5faa710ca09342cdef88d24e6349b6e5d590ccca215065354d` |
| seed ID | `d3b9638c866b2e5d447a62ef0bd0fd7877950dcfa9fb971b50c0927fc96e4d00` |
| timeout grant SHA-256 | `d52aafa542d7c9321158c74716ebc08d4e364356b216804856edac1e91cd5338` |
| timeout consumption claim SHA-256 | `b30c8999016d555208deff3ac8c7826f9a4bb6106b4a1d8c8c14905455af24e6` |
| A2 rearm repair ID | `a08b53ee30c0320bc8c2783df1087392a42e33a283a776630206a857412b7dc6` |

The source profile also pins the seed receipt/commit/journal, run identity, ledger identity and
sidecar, timeout issuance and sidecar, predecessor evidence tree, rearm after-state hashes, modes,
owners, paths, file counts, and byte counts.

## Lock and unit boundary

The continuation uses the existing `.a2-lifecycle.lock`, opened with `O_NOFOLLOW` and held through
an inherited file descriptor using `/usr/bin/flock`. It is acquired before the first incident or
unit inspection and is held through terminal durability plus the final five-unit check. The held
descriptor and the pathname must continue to identify the same frozen device/inode, mode-0600,
single-link current-owner file. That identity is rechecked at every journal/control transition,
after child exit, before terminal durability, and during closeout; unlink-and-recreate is fatal even
though the old descriptor still owns a flock. A failed stop or final gate is fatal, but closeout
still releases the flock rather than orphaning it.

On a new claim, the first gate requires these five units to be loaded, quiescent, and process-free:

1. `curriculum-ocr-reprocess-a-r2.service`;
2. `curriculum-ocr-reprocess-a-r2-monitor.service`;
3. `curriculum-ocr-reprocess-a-r2-monitor.timer`;
4. `curriculum-ocr-monitor-alert@curriculum-ocr-reprocess-a-r2-monitor.service.service`;
5. `curriculum-ocr-llama.service`.

The worker must retain InvocationID `cea416...` and `ExecMainStatus=75`. The worker, monitor,
monitor timer, and alert unit are frozen as one lifecycle fence containing their exact unit name,
InvocationID/PID/exit status, active/sub states, and systemd monotonic generation timestamps
(`LastTriggerUSecMonotonic` for the timer). Thus a monitor or timer that transiently starts and
returns inactive still changes the fence and aborts the continuation. Apply starts only the exact
llama unit under the held lifecycle lock, captures its real InvocationID/MainPID, validates the
pinned runtime, and immediately before child spawn rechecks the frozen fence, the same active llama
InvocationID, every frozen control hash, output/evidence/lifecycle identities, pre-existing
directory identities, and the log inode. Closeout stops llama and proves all five units quiescent
and the four-unit fence unchanged, reporting any stop/gate/release failures together.

After an abrupt process death, restart first validates the archived receipt/claim/runtime manifest
and the frozen four-unit fence. The durable `claimed` state contains a deterministic llama-start
nonce seed before any service start. For each execution ordinal, the continuation derives one nonce,
places it in the user systemd manager environment, starts llama, proves the exact value in
`/proc/<MainPID>/environ`, and then clears the manager copy. A crash after service start but before a
`running` state can therefore adopt only that exact marked InvocationID/MainPID; a different or
unmarked active service is never stopped. A trailing `running`/`resume_running_NNNN` state owns an
OCR process family through its random 256-bit spawn nonce plus exact command SHA-256 in the process
environment, and owns llama through the recorded InvocationID/MainPID and start nonce. Every OCR
candidate also records its current-UID `/proc` start time; marker, UID, start time, and command are
re-read immediately before each TERM/KILL. Llama InvocationID/MainPID and its process marker are
likewise re-read immediately before stop. Any replacement fails closed and survives. Only after the
exact owned processes are gone and all five units are quiescent may the same attempt 6 resume. A dry
run never performs this recovery mutation.

## Disjoint, crash-resumable evidence

Continuation evidence is outside the monitored output root, under:

```text
<A2_EVIDENCE_BASE>/operator-forward-continuations/
  legacy-compendium-english/attempt-0006/
    receipt.json{,.sha256}
    claim.json{,.sha256}
    interrupted-run-status.json{,.sha256}
    interrupted-status.json{,.sha256}
    interrupted-state.json{,.sha256}
    pre-continuation.log{,.sha256}
    document-inventory.json{,.sha256}
    runtime-manifest.json{,.sha256}
    states/
      000001-claimed.json{,.sha256}
      000002-running.json{,.sha256}
      [000003-partial_checkpoint_0001.json{,.sha256}
       000004-resume_running_0001.json{,.sha256} ...]
      N-terminal_plan.json{,.sha256}
      N+1-terminal.json{,.sha256}
```

This preserves the monitor's exact B2 output-root allowlist. The receipt directory is atomically
renamed into place. The claim binds its receipt, output device/inode, and continuation-evidence
device/inode. Claim and journal pairs recover deterministic body-only or sidecar-only crash states;
different bytes fail closed.

The live `run-status.json`, document status, and their sidecars remain at the original interrupted
bytes while OCR runs. Before any terminal replacement, an immutable `terminal_plan` state stores the
four exact before/after records. Each live file must be exactly before or exactly after, so restart
can finish a partially applied four-file transaction without rerunning OCR. Recovery reads and
applies an existing `terminal_plan` before calling the ordinary seed verifier; this ordering covers
crashes after zero through four replacements. The terminal journal is append-only and hash chained.
Every `running` state also binds a unique 256-bit spawn nonce and the exact Python/argument command
SHA-256; both are injected into the child environment so an abrupt-death restart can distinguish
owned descendants from unrelated processes. Every restarted child receives the next contiguous
`resume_running_NNNN` state, with a new verified llama InvocationID/PID, a fresh spawn nonce, and the
SHA-256 of the preceding execution state. Neither an InvocationID nor a spawn nonce may be reused in
the chain.

Before any `resume_running_NNNN` state may be appended, restart validates the previous execution's
output with the typed strict partial-document validator and appends a matching
`partial_checkpoint_NNNN` state. That hash-chained checkpoint binds the original frozen tree/state/
log baseline, the exact execution-state SHA-256, the full current strict tree entry inventory, the
current state bytes plus device/inode, every current directory identity, and the append-only log's
device/inode/hash/byte count and prior prefix hash/length. The resume state binds both the preceding
execution and checkpoint hashes. A generic validation error never qualifies as an incomplete
document; only `IncompleteOcrDocumentError` followed by a successful `requireComplete:false` strict
validation permits a checkpoint and resume.

An unmonitored child `SIGKILL` is the one signal eligible for this non-terminal path. It must leave
at least one additional strictly valid completed page, a changed valid state, and an extended
same-inode log. The current invocation durably appends and readback-verifies the checkpoint, returns
`resumable` with exit 75, and leaves the claim on attempt 6 for the next invocation. A different
signal, a monitor incident, no durable page progress, a generic validation error, a complete result,
or a failed strict partial validation retains the fatal quarantine behavior and terminal plan.

Each terminal record uses a deterministic temp pathname derived from the immutable terminal-plan
state SHA-256, output path, and exact after hash/byte count. Before writing target bytes, an adjacent
durable ownership receipt binds that plan, the exact before/after records, path, and newly created
temp device/inode. The mode-0600, current-owner, single-link temp is opened with `O_NOFOLLOW`, written
in fsynced chunks on that same inode, and fsynced with its parent before rename. Restart may rewrite a
zero-length or partial temp only when the receipt is canonical for the exact plan/inode and the bytes
are an exact prefix of the expected after image. An unbound empty placeholder is discarded and
recreated with a new receipt; exact-after bytes remain convergent; any non-prefix or otherwise
unbound third bytes fail closed. The target-after case removes a leftover temp/receipt, so deaths
during write, after temp fsync, or after rename all converge without accepting foreign content.

The checked-in `data/remote-ocr-a2-continuation-runtime-manifest.json` independently lists and hashes
the complete relative-import closure actually executed by the continuation entrypoint, including
the continuation script, validator library, immutable base runner, monitor and repair dependencies.
The manifest deliberately does not hash itself, avoiding a fixed-point/self-hash claim. Its raw
bytes, file count and runtime tree hash are embedded in receipt authorization and archived as the
hash-bound `runtime-manifest.json` pair. Startup recomputes the closure before taking the lock;
validator and receiver compare the archive against their own trusted checked-in manifest and local
source bytes.

## Forward-only output rules

- Every pre-existing document-tree path except `state.json` stays byte-identical.
- After a partial checkpoint, every page artifact captured by that checkpoint also becomes
  immutable; completed-page metadata in later states must be a monotonic exact superset.
- Every pre-existing directory keeps device, inode, mode, UID, and GID.
- Before the first OCR spawn, both the frozen state and log must retain their original device and
  inode as well as their exact bytes; a same-bytes atomic state replacement is rejected.
- New paths may exist only below a previously absent canonical `pages/NNNN` within the document page
  range.
- A new page may contain only `result.json`, `content.md`, `markdown/`, and `visual/` families.
- Hidden, temporary, staging, out-of-range, or additions inside an existing page are rejected.
- The log must retain the same device/inode, cannot shrink, and must begin with the exact archived
  byte prefix.
- The ordinary complete whole-document validator remains mandatory.

Output reads use `O_NOFOLLOW`, handle `fstat` before/after, pathname inode rechecks, single-link and
owner/mode checks. Tree walks use stable file reads and reject symlinks/non-regular entries.

## Exit semantics and restart

- `0`: complete attempt 6.
- `75`: a second operator stop; attempt 6 remains interrupted.
- `2`: child exit 2 or shared-runtime revalidation failure; terminal status is `failed` with
  `failure_class=shared_runtime_configuration`.
- `12`: content/monitor/whole-document/forward-only validation failure; terminal status is
  `quarantined`.

A restart with a deterministic partial claim or state pair repairs the missing half. A restart with
`terminal_plan` completes only remaining exact-before replacements. A restart after the child
finished but before terminal planning validates the forward result and completes without invoking
OCR again. An incomplete forward result may resume the same already-claimed attempt 6; it never
increments or resets the attempt. A timeout predecessor's `failed_at` remains in the completed
attempt-6 lifecycle record, as required by receiver validation.

Local regression coverage includes an OCR writer that persists a valid new page, state and log
entry and is then actually killed with `SIGKILL`; the interrupted invocation checkpoints those
bytes without a terminal plan and the next invocation completes the remaining page. Separate tests
reject no-progress or non-`SIGKILL` signal recovery, generic/corrupt partial validation, first-spawn
state inode replacement, page replacement, state truncation or checkpoint inode replacement, log
truncation or inode replacement, log-prefix mutation, and directory-inode replacement before OCR
respawn. Two process/lock checks remain intentionally Linux-only and must run on the sealed target
before an A2 canary: exact `/proc` ownership discovery/termination and inherited-fd lifecycle-flock
exclusion/pathname-replacement detection. They are skipped on macOS; this change does not claim a
remote Linux run.

## Command, after profile release

Only runtime/input options and the two operator-action timestamps are supplied. Incident hashes,
paths, InvocationID, interruption time, devices, inodes, grant, claim, and rearm authority are not
CLI arguments.

```bash
node <SEALED_RUNTIME>/scripts/continue-remote-ocr-operator-interruption.mjs \
  <EXACT_ORIGINAL_A2_MANIFEST_INPUT_AND_RUNTIME_OPTIONS> \
  --document-id legacy-compendium-english \
  --attempt 6 \
  --authorized-at '<CANONICAL_UTC_MS>' \
  --continued-at '<CANONICAL_UTC_MS>'
```

Run the same command with `--apply` only after two mutation-free previews agree and the independent
review releases the profile. Do not start services or touch A2 merely to fill profile values.

## Receiver gate

The receiver accepts `--continuation-evidence-root` once per shard (`-` for other shards). For the
exact A2 root, omission is fatal. Evidence on any non-A2 shard is also fatal. The receiver:

- matches the frozen output path plus seed receipt, grant, consumption claim, runner, and English
  manifest identity;
- validates receipt, claim, all sidecars, state hash chain, terminal complete/exit 0, and evidence
  directory inode binding;
- independently recomputes its local continuation runtime closure and requires the archived runtime
  manifest plus receipt descriptor to match byte-for-byte;
- independently rechecks live complete attempt 6, strict forward-only tree, and append-only log;
- accepts the extra `forward_document_tree` and `append_only_log` terminal artifacts only when they
  exactly equal the already-validated continuation output for that document;
- fingerprints the continuation evidence and live output in source-shard identity;
- archives the entire continuation tree under receiver `source-evidence`, verifies tree equality,
  then reads back receipt, claim, inventory, and sidecars;
- revalidates the archive and fingerprints on idempotent receiver entry.

OCR completion remains `citation_allowed=false`; receiver acceptance is still not a publication or
citation release.
