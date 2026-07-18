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
state directory. The healthy monitor post-hook waits up to 60 seconds, which
covers one final systemd probe plus the bounded pending and current delivery
attempts without converting a healthy monitor into a lock-contention failure.
The kernel releases the lock automatically when a process exits or crashes, so
a stale directory cannot permanently suppress alerting.

## Delivery and deduplication

Before a sender is called, the notifier persists an immutable, privacy-safe
failure envelope and its SHA-256. Every pending envelope is validated before
new runtime evidence is consulted. Alert mode sends or evaluates evidence only
when systemd reports the monitor in the terminal `inactive` or `failed` state;
`activating`, `active`, `deactivating`, `reloading`, maintenance, and unknown
states defer successfully without changing the pending envelope. Once the
monitor is terminal, the pending envelope is retried before that final runtime
is evaluated. After a successful retry, the same handler still evaluates and
persists the final invocation so a newer failure cannot disappear behind the
older delivery.

The enabled `curriculum-ocr-monitor-alert-retry@.timer` starts the handler every
two minutes as an independent liveness path. This guarantees that a pending
envelope is revisited after a long provider outage, after the service restart
rate limit has been reached, and after a user-manager restart, even if later OCR
monitor invocations are healthy.

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
owner-only credential file separately, verify the service, retry timer, monitor,
and drop-in with `systemd-analyze --user verify`, enable the retry timer for the
exact monitor-unit instance, then arm only after two healthy exit-10 cycles.

Rollback disables and removes only the retry timer, alert handler, and B-r3
monitor drop-in; OCR output and worker state remain untouched.
