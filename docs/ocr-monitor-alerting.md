# OCR monitor alerting contract

The B-r3 alert layer reports a failed single-shard monitor without stopping,
restarting, or mutating OCR. It is intentionally fail-closed: a failure is sent
only after two distinct healthy exit-10 monitor invocations have armed one exact
run lineage.

The schema-v2 armed receipt binds all of the following:

- expected run ID
- current Linux boot ID
- worker systemd unit
- nonzero worker `InvocationID`
- monitor script SHA-256

Observe mode always requires a live nonzero worker `InvocationID`. Alert mode
may recover a temporarily empty live worker `InvocationID` only from a valid
armed receipt whose run, boot, worker unit, and monitor hash all match the
current configuration. A different nonempty worker `InvocationID` never reuses
the prior receipt. If no exact receipt exists yet, alert mode records a local
`suppressed_disarmed` result and exits successfully without sending or entering
a restart loop; observe mode remains the only path that can arm a new binding.

Both systemd entrypoints use bounded `/usr/bin/flock` locking on the external
state directory. The kernel releases the lock automatically when a process
exits or crashes, so a stale directory cannot permanently suppress alerting.

## Delivery and deduplication

Before a sender is called, the notifier persists an immutable, privacy-safe
failure envelope and its SHA-256. A pending envelope is retried before newer
monitor runtime evidence is evaluated, including when the latest invocation is
already healthy.

Telegram delivery is **at-least-once**. If Telegram accepts a message but the
local sent checkpoint cannot be committed, retry can produce a duplicate.
Every visible message therefore includes the stable 64-hex issue fingerprint;
operators and downstream tooling should use it for deduplication.

An immediate repeat of the same issue is deduplicated. The first subsequent
healthy exit-10 observation closes every sent incident for that binding and
advances the recovery epoch. The same issue can then alert again if it recurs.

The outbound envelope contains only the run ID, monitor unit, issue codes,
fingerprint, timestamp, and bounded page progress. Boot IDs, systemd invocation
IDs, credentials, source text, and OCR page content are never sent.

## Deployment gate

This contract uses state schema version 2 and must be installed before the first
production alert deployment. Do not reuse schema-v1 alert state. Populate the
non-secret configuration from
`ops/systemd/curriculum-ocr-monitor-alert.conf.example`, provision the dedicated
owner-only credential file separately, verify both units with
`systemd-analyze --user verify`, then arm only after two healthy exit-10 cycles.

Rollback disables and removes only the alert handler and B-r3 monitor drop-in;
OCR output and worker state remain untouched.
