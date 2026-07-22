# A2 operator-interrupted attempt 6 forward continuation

This procedure is for one incident only: `legacy-compendium-english`, already-consumed attempt 6,
was stopped by the operator after an observer-side `jq` mistake. It does not create another timeout
grant, reset the attempt count, or authorize attempt 7.

## Current release gate: intentionally blocked

The executable owns the incident profile in
`scripts/lib/remote-ocr-operator-continuation.mjs`. Incident identity is not accepted from CLI flags.
The production profile intentionally contains `null` for independently unconfirmed values:

- the complete operator-freeze incident evidence tree SHA-256;
- the A2 rearm `repair-receipt.json` SHA-256 and byte count;
- the A2 rearm reservation-claim SHA-256;
- the complete A2 rearm evidence tree SHA-256.

`validateA2ForwardContinuationProfile()` rejects the profile before acquiring the lifecycle lock or
reading A2. Do not substitute values from an operator command, a copied tree, or the unrelated
`22eae7d9...` r5 repair. One independently approved, bounded, read-only collection must recover the
remaining values; source review must then pin them before any dry run or apply is possible.

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
unit inspection and is held through terminal durability plus the final five-unit check. A failed
stop or final gate is fatal, but closeout still releases the flock rather than orphaning it.

The first gate requires these five units to be loaded, quiescent, and process-free:

1. `curriculum-ocr-reprocess-a-r2.service`;
2. `curriculum-ocr-reprocess-a-r2-monitor.service`;
3. `curriculum-ocr-reprocess-a-r2-monitor.timer`;
4. `curriculum-ocr-monitor-alert@curriculum-ocr-reprocess-a-r2-monitor.service.service`;
5. `curriculum-ocr-llama.service`.

The worker must retain InvocationID `cea416...` and `ExecMainStatus=75`. Apply starts only the exact
llama unit under the held lifecycle lock, captures its real InvocationID/MainPID, validates the
pinned runtime, and immediately before child spawn rechecks the other four quiescent units, the
same active llama InvocationID, every frozen control hash, output/evidence/lifecycle identities,
pre-existing directory identities, and the log inode. Closeout stops llama and proves all five
units quiescent, reporting any stop/gate/release failures together.

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
    states/
      000001-claimed.json{,.sha256}
      000002-running.json{,.sha256}
      000003-terminal_plan.json{,.sha256}
      000004-terminal.json{,.sha256}
```

This preserves the monitor's exact B2 output-root allowlist. The receipt directory is atomically
renamed into place. The claim binds its receipt, output device/inode, and continuation-evidence
device/inode. Claim and journal pairs recover deterministic body-only or sidecar-only crash states;
different bytes fail closed.

The live `run-status.json`, document status, and their sidecars remain at the original interrupted
bytes while OCR runs. Before any terminal replacement, an immutable `terminal_plan` state stores the
four exact before/after records. Each live file must be exactly before or exactly after, so restart
can finish a partially applied four-file transaction without rerunning OCR. The terminal journal is
append-only and hash chained.

## Forward-only output rules

- Every pre-existing document-tree path except `state.json` stays byte-identical.
- Every pre-existing directory keeps device, inode, mode, UID, and GID.
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
increments or resets the attempt.

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
- independently rechecks live complete attempt 6, strict forward-only tree, and append-only log;
- fingerprints the continuation evidence and live output in source-shard identity;
- archives the entire continuation tree under receiver `source-evidence`, verifies tree equality,
  then reads back receipt, claim, inventory, and sidecars;
- revalidates the archive and fingerprints on idempotent receiver entry.

OCR completion remains `citation_allowed=false`; receiver acceptance is still not a publication or
citation release.
