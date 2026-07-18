# Timeout-recovery authority operations

The timeout-recovery grant is a one-time exception for a settled, unseeded p4 OCR predecessor whose documents exhausted attempts 1–5 only because the OCR child hit the exact idle-timeout contract. It is not a general retry override.

## Canonical authority

For an input root `<parent>/<input>`, the sole authority is the pre-existing directory:

```text
<parent>/timeout-recovery-authority-v1
```

The directory must be a real, current-UID/GID-owned mode-0700 directory. Its `ledger-identity.json` and `.sha256` sidecar must already exist as current-UID/GID-owned, mode-0600, single-link regular files. The deterministic identity binds the canonical input path, authority path, filesystem device/inode, UID, and GID. The preparer never creates or repairs this authority identity.

Every eligible predecessor produces one deterministic claim key from its predecessor hashes, policy, and ordered document evidence. The authority publishes exactly one `<claim-key>.issuance.json` before the predecessor grant. Copies of the same predecessor that still point at the same input root converge on that one issuance; an alternate authority path is rejected.

Provision the authority once with the dedicated command; never hand-write the identity and never expect the grant preparer to create it:

```bash
node scripts/provision-timeout-recovery-authority.mjs --input-root <INPUT_ROOT>
node scripts/provision-timeout-recovery-authority.mjs --input-root <INPUT_ROOT> --apply
```

The first command is mutation-free. `--apply` exclusively allocates the mode-0700 canonical directory, derives its identity only after the directory inode exists, and publishes the mode-0600 identity and sidecar through `O_EXCL|O_NOFOLLOW`, temporary-inode `fsync`, hard-link no-replace, and parent-directory `fsync`. An exact rerun is idempotent; arbitrary existing bytes, symlinks, wrong ownership/modes, and orphan sidecars are rejected. Run this before grant inspection and record the returned ledger ID in the private operations log.

## Publication and crash recovery

Incident, issuance, grant, and consumption files are published as follows:

1. create a mode-0600 temporary inode with `O_EXCL|O_NOFOLLOW`;
2. write and `fsync` that inode;
3. hard-link it to the final name, which gives no-replace semantics;
4. unlink the temporary name and `fsync` the parent directory;
5. publish and verify the SHA-256 sidecar the same way.

A final file is therefore either absent or contains the complete intended bytes. On restart, an inactive publication temporary file is removed only after verifying its inode, owner, mode, link count, containment, and process ownership. An existing final with different bytes is never repaired or overwritten. A crash between raw-file and sidecar publication may be resumed only when the surviving raw bytes are exactly the recomputed evidence; the canonical authority identity is the exception and must never be repaired.

## Rollback and resume boundary

The authority identity includes filesystem device and inode, which rejects ordinary copies, directory recreation, archive extraction, and cross-filesystem restores. It does **not** make a same-inode filesystem snapshot rollback safe: a pre-claim snapshot could erase a later issuance or consumption claim while retaining the same identity.

Therefore an authority loss or rollback is blocked. Never restore a pre-claim snapshot and reissue, even when its device/inode is unchanged. Never reconstruct the authority from its JSON files. Retain the predecessor and successor as immutable evidence and stop. A future reissue would require an independently audited epoch protocol plus an external non-rollback/WORM checkpoint proving the last issued and consumed claim; the current commands intentionally do not implement that escape hatch.

The live canonical authority is required through the first seed commit. After `seed-commit.json` exists, the runner resumes from the successor's immutable grant, canonical-basename issuance pair, incident pairs, ledger identity pair, consumption claim pair, receipt, and marker. Resume revalidates the claim's successor output path, filesystem device, and inode, so a copied successor cannot execute. A copy remains usable only as receiver/monitor evidence. Resume does not consult or restore the live authority and cannot authorize another seed.

The archived ledger identity supports internal hash and cross-evidence verification. Because its public JSON does not expose the UID/GID inputs that were folded into the deterministic nonce, an offline receiver must not claim to have independently recomputed the original authority basis.

## Required evidence

Each granted document must have:

- exact attempt 5 / max attempts 5 / `attempt_budget_exhausted` status and sidecar;
- an error of `OCR child idle_timeout after <seconds>s; terminated with SIGTERM` (or the exact SIGKILL escalation form);
- a mode-0600 final document log bound by byte length and SHA-256;
- a structured attempt-5 timeout incident bound to document, attempt, timeout type, child/detection/record timestamps, elapsed/idle seconds, termination signals, full monitoring policy, runtime fingerprint, and final log identity.

For the historical A1 predecessor, the incident may be deterministically derived once from the exact sealed status plus final log only when the log has exactly five Paddle `SignalInfo: *** SIGTERM` rows. The derivation is marked `legacy_status_log_derivation_v1`; uncertainty or any other row count is rejected.

All recovery evidence remains `citation_allowed: false`.
