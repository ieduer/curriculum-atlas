# DMITPro2 inner A2 OCR release runbook

This is the executable release and rollback procedure for the sealed
`production-p1-mb16-shard-a-r2` continuation. It changes only the user-level
OCR runtime on the **DMITPro2 inner bdfz workstation**. It does not publish OCR
text, update the website, write Cloudflare, D1, or R2, or make a page
citation-eligible.

The target is inner host `bdfz`, behind outer host label `dmitpro2`
(`69.63.212.156`). The manual access path is exactly:

```bash
ssh dmitpro2
ssh -p 22222 suen@localhost
```

`localhost:22222` is interpreted on the outer host. Never put an interactive
credential in a command, file, report, commit, or shell history. Automation is
allowed only after a dedicated public key is installed interactively for inner
account `suen` and the same key passes `BatchMode=yes`.

## 0. Stop gates and local connection

Stop before the first remote write unless all conditions hold:

1. An independent reviewer approved one exact 40-hex A2 Git commit, with local
   focused and full gates green.
2. The dedicated inner-host key is owner-only and the pinned host key already
   exists. Never use `StrictHostKeyChecking=no`.
3. B-r3 is complete and disabled. Old A/B/B-r2 workers and the p1 canary are
   inactive/dead with `MainPID=0`.
4. A1, the manifest, verified PDFs, model, mmproj, Python runtime, PaddleX
   cache, and loopback llama runtime exist at the exact reviewed paths.
5. Disk has more than 50 GiB free, memory more than 1 GiB available, GPU is
   below 85 C, and no unexplained failed unit or listener conflict exists.
6. `workspace-a-r2` and the A2 successor do not contain another attempt.

From the Mac, use zsh and replace only the two bracketed values:

```zsh
set -euo pipefail
umask 077
REPO=/Users/ylsuen/CF/curriculum-atlas
A2_GIT_COMMIT="<REVIEWED_A2_GIT_COMMIT>"
A2_KEY="<A2_DEDICATED_PRIVATE_KEY>"

test "${#A2_GIT_COMMIT}" -eq 40
printf '%s\n' "$A2_GIT_COMMIT" | grep -Eq '^[0-9a-f]{40}$'
test -f "$A2_KEY"
test "$(stat -f '%Lp' "$A2_KEY")" = 600
git -C "$REPO" cat-file -e "$A2_GIT_COMMIT^{commit}"
git -C "$REPO" merge-base --is-ancestor ed93e44 "$A2_GIT_COMMIT"

typeset -a SSH_INNER SCP_INNER
SSH_INNER=(ssh -o BatchMode=yes -o IdentitiesOnly=yes \
  -o HostKeyAlias=DMITPro2-inner-bdfz \
  -o "ProxyCommand=ssh dmitpro2 -W localhost:22222" \
  -i "$A2_KEY" suen@localhost)
SCP_INNER=(scp -o BatchMode=yes -o IdentitiesOnly=yes \
  -o HostKeyAlias=DMITPro2-inner-bdfz \
  -o "ProxyCommand=ssh dmitpro2 -W localhost:22222" \
  -i "$A2_KEY")

"${SSH_INNER[@]}" 'test "$(hostname)" = bdfz && test "$(whoami)" = suen'
```

Run the read-only machine roll call before mutation:

```zsh
"${SSH_INNER[@]}" 'set -eu
hostname
whoami
uptime
df -hT /
free -h
nvidia-smi
systemctl --failed
ss -lntup
docker ps
command -v node
command -v jq
command -v sha256sum
command -v systemd-analyze
command -v zstd
systemctl --user show \
  curriculum-ocr-reprocess@a.service \
  curriculum-ocr-reprocess@b.service \
  curriculum-ocr-reprocess-b-r2.service \
  curriculum-ocr-reprocess-b-r3.service \
  curriculum-ocr-llama-p1-canary.service \
  --property=Id --property=LoadState --property=UnitFileState \
  --property=ActiveState --property=SubState --property=MainPID \
  --property=NRestarts --no-pager'
```

Do not infer safety from `active` alone. Any ambiguous row is a hard stop.

## 1. Backup and pre-grant evidence

This backs up only files the release may replace. It deliberately excludes the
dedicated delivery credential. The A1 hash list is evidence, not permission to
restore authority or predecessor state after grant issuance.

```zsh
"${SSH_INNER[@]}" 'bash -se' <<'REMOTE'
set -euo pipefail
umask 077
RUN_ROOT=/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess
A1="$RUN_ROOT/output/production-p4-mb16-shard-a-r1"
A2="$RUN_ROOT/output/production-p1-mb16-shard-a-r2"
WORKSPACE="$RUN_ROOT/workspace-a-r2"
MONITOR_DIR="$RUN_ROOT/monitor-a-r2"
ALERT_RUNTIME="$HOME/curriculum-ocr-offload/alert-runtime"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="$RUN_ROOT/backups/pre-a2-release-$STAMP"
EVIDENCE="$RUN_ROOT/a2-deploy-evidence/$STAMP"
test ! -e "$RUN_ROOT/.a2-current-backup"
test ! -L "$RUN_ROOT/.a2-current-backup"
test ! -e "$RUN_ROOT/.a2-current-evidence"
test ! -L "$RUN_ROOT/.a2-current-evidence"
test ! -e "$BACKUP"
test ! -e "$EVIDENCE"
mkdir -m 700 -p "$(dirname "$BACKUP")" "$(dirname "$EVIDENCE")"
mkdir -m 700 "$BACKUP" "$EVIDENCE"
mkdir -m 700 "$BACKUP/files"

if test -L "$ALERT_RUNTIME"; then
  echo 'alert-runtime must not be a symbolic link' >&2
  exit 1
elif test -d "$ALERT_RUNTIME"; then
  test "$(stat -c %a "$ALERT_RUNTIME")" = 700
  test "$(stat -c %u "$ALERT_RUNTIME")" = "$(id -u)"
  printf 'state=present\nmode=700\n' > "$BACKUP/alert-runtime-state.env"
elif test -e "$ALERT_RUNTIME"; then
  echo 'alert-runtime exists but is not a directory' >&2
  exit 1
else
  printf 'state=absent\n' > "$BACKUP/alert-runtime-state.env"
fi
chmod 600 "$BACKUP/alert-runtime-state.env"
for alert_file in \
  "$ALERT_RUNTIME/notify-remote-ocr-single-shard-monitor.mjs" \
  "$ALERT_RUNTIME/SHA256SUMS"; do
  if test -e "$alert_file" || test -L "$alert_file"; then
    test -f "$alert_file"
    test ! -L "$alert_file"
    test "$(stat -c %u "$alert_file")" = "$(id -u)"
  fi
done

paths=(
  "$HOME/.config/systemd/user/curriculum-ocr-llama.service"
  "$HOME/.config/systemd/user/curriculum-ocr-reprocess-a-r2.service"
  "$HOME/.config/systemd/user/curriculum-ocr-reprocess-a-r2-cleanup.service"
  "$HOME/.config/systemd/user/curriculum-ocr-reprocess-a-r2-monitor.service"
  "$HOME/.config/systemd/user/curriculum-ocr-reprocess-a-r2-monitor.timer"
  "$HOME/.config/systemd/user/curriculum-ocr-reprocess-a-r2-monitor.service.d/alert-only.conf"
  "$HOME/.config/systemd/user/curriculum-ocr-monitor-alert@.service"
  "$HOME/.config/systemd/user/curriculum-ocr-monitor-alert-retry@.timer"
  "$HOME/.config/bdfz/curriculum-ocr-reprocess-a-r2-cleanup.conf"
  "$HOME/.config/bdfz/curriculum-ocr-monitor-alert.conf"
  "$HOME/curriculum-ocr-offload/alert-runtime/notify-remote-ocr-single-shard-monitor.mjs"
  "$HOME/curriculum-ocr-offload/alert-runtime/SHA256SUMS"
)
for pathname in "${paths[@]}"; do
  relative=${pathname#"$HOME/"}
  if test -e "$pathname" || test -L "$pathname"; then
    mkdir -p "$BACKUP/files/$(dirname "$relative")"
    cp -a --no-dereference "$pathname" "$BACKUP/files/$relative"
    printf 'present\t%s\n' "$relative" >> "$BACKUP/file-state.tsv"
  else
    printf 'absent\t%s\n' "$relative" >> "$BACKUP/file-state.tsv"
  fi
done
chmod 600 "$BACKUP/file-state.tsv"

systemctl --user show curriculum-ocr-llama.service \
  curriculum-ocr-reprocess-a-r2.service \
  curriculum-ocr-reprocess-a-r2-cleanup.service \
  curriculum-ocr-reprocess-a-r2-monitor.service \
  curriculum-ocr-reprocess-a-r2-monitor.timer \
  curriculum-ocr-reprocess-b-r3-monitor.service \
  curriculum-ocr-monitor-alert@curriculum-ocr-reprocess-b-r3-monitor.service.service \
  --property=Id --property=LoadState --property=UnitFileState \
  --property=ActiveState --property=SubState --property=MainPID \
  --property=InvocationID --property=NRestarts --no-pager \
  > "$BACKUP/systemd-before.txt"
B3_MONITOR_STATE=$(systemctl --user is-enabled \
  curriculum-ocr-reprocess-b-r3-monitor.timer 2>/dev/null || true)
B3_ALERT_STATE=$(systemctl --user is-enabled \
  curriculum-ocr-monitor-alert-retry@curriculum-ocr-reprocess-b-r3-monitor.service.timer \
  2>/dev/null || true)
for timer_state in "$B3_MONITOR_STATE" "$B3_ALERT_STATE"; do
  case "$timer_state" in
    enabled|enabled-runtime|disabled) ;;
    *) echo "unexpected B-r3 timer state: $timer_state" >&2; exit 1 ;;
  esac
done
printf 'b3_monitor_timer=%s\nb3_alert_retry_timer=%s\n' \
  "$B3_MONITOR_STATE" "$B3_ALERT_STATE" > "$BACKUP/b3-timer-state.env"
chmod 600 "$BACKUP/b3-timer-state.env"

test -d "$A1"
test ! -L "$A1"
test ! -e "$WORKSPACE"
test ! -e "$A2"
test ! -e "$MONITOR_DIR"
test ! -L "$MONITOR_DIR"
(
  cd "$A1"
  find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
) > "$EVIDENCE/a1-pregrant.SHA256SUMS"
sha256sum "$EVIDENCE/a1-pregrant.SHA256SUMS" \
  > "$EVIDENCE/a1-pregrant.SHA256SUMS.sha256"

AUTHORITY="$RUN_ROOT/input/timeout-recovery-authority-v1"
test -d "$AUTHORITY"
test ! -L "$AUTHORITY"
test "$(stat -c %a "$AUTHORITY")" = 700
test -f "$AUTHORITY/ledger-identity.json"
test -f "$AUTHORITY/ledger-identity.json.sha256"
(cd "$AUTHORITY" && sha256sum --check --strict ledger-identity.json.sha256)
printf '%s\n' "$BACKUP" > "$RUN_ROOT/.a2-current-backup"
printf '%s\n' "$EVIDENCE" > "$RUN_ROOT/.a2-current-evidence"
chmod 600 "$RUN_ROOT/.a2-current-backup" "$RUN_ROOT/.a2-current-evidence"
printf 'backup=%s\nevidence=%s\n' "$BACKUP" "$EVIDENCE"
REMOTE
```

If an assertion fails, stop. Do not create a second authority or repair an
unexpected A1 tree.

## 2. Materialize the exact reviewed Git tree

Create a package from the reviewed commit, never from the working tree. It
contains every transitive local module used by grant, runner, monitor, and
cleanup, plus the exact units to install.

```zsh
LOCAL_STAGE=$(mktemp -d /private/tmp/curriculum-a2-source.XXXXXX)
LOCAL_TAR="$LOCAL_STAGE.tar"
trap 'rm -rf "$LOCAL_STAGE" "$LOCAL_TAR"' EXIT INT TERM

git -C "$REPO" archive --format=tar "$A2_GIT_COMMIT" -- \
  scripts/provision-timeout-recovery-authority.mjs \
  scripts/prepare-timeout-recovery-grant.mjs \
  scripts/run-remote-ocr-offload.mjs \
  scripts/monitor-remote-ocr-single-shard.mjs \
  scripts/monitor-remote-ocr-reprocess.mjs \
  scripts/notify-remote-ocr-single-shard-monitor.mjs \
  scripts/cleanup-remote-ocr-completion.mjs \
  scripts/ocr-pdf-paddle.py \
  scripts/lib/remote-ocr-local-snapshot.mjs \
  ops/systemd/curriculum-ocr-llama.service \
  ops/systemd/curriculum-ocr-reprocess-a-r2.service \
  ops/systemd/curriculum-ocr-reprocess-a-r2-cleanup.service \
  ops/systemd/curriculum-ocr-reprocess-a-r2-cleanup.conf.example \
  ops/systemd/curriculum-ocr-reprocess-a-r2-monitor.service \
  ops/systemd/curriculum-ocr-reprocess-a-r2-monitor.timer \
  ops/systemd/curriculum-ocr-reprocess-a-r2-monitor.service.d/alert-only.conf \
  ops/systemd/curriculum-ocr-reprocess-a-r2-monitor-alert.conf.example \
  ops/systemd/curriculum-ocr-monitor-alert@.service \
  ops/systemd/curriculum-ocr-monitor-alert-retry@.timer \
  | tar -xf - -C "$LOCAL_STAGE"

printf '%s\n' "$A2_GIT_COMMIT" > "$LOCAL_STAGE/SOURCE_COMMIT"
(
  cd "$LOCAL_STAGE"
  find . -type f ! -name SOURCE_SHA256SUMS -print0 \
    | LC_ALL=C sort -z | xargs -0 sha256sum > SOURCE_SHA256SUMS
  sha256sum --check --strict SOURCE_SHA256SUMS
)
tar -C "$LOCAL_STAGE" -cf "$LOCAL_TAR" .
LOCAL_TAR_SHA=$(sha256sum "$LOCAL_TAR" | awk '{print $1}')

REMOTE_UPLOAD=/home/suen/curriculum-ocr-offload/staging/$(basename "$LOCAL_TAR")
"${SSH_INNER[@]}" 'mkdir -p -m 700 /home/suen/curriculum-ocr-offload/staging'
"${SCP_INNER[@]}" "$LOCAL_TAR" "suen@localhost:$REMOTE_UPLOAD"
"${SSH_INNER[@]}" "set -eu
RUN_ROOT=/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess
WORKSPACE=\$RUN_ROOT/workspace-a-r2
STAGE=\$RUN_ROOT/.workspace-a-r2.stage-$A2_GIT_COMMIT
test ! -e \"\$WORKSPACE\"
test ! -e \"\$STAGE\"
test \"\$(sha256sum '$REMOTE_UPLOAD' | awk '{print \$1}')\" = '$LOCAL_TAR_SHA'
mkdir -m 700 \"\$STAGE\"
tar -xf '$REMOTE_UPLOAD' -C \"\$STAGE\"
test \"\$(cat \"\$STAGE/SOURCE_COMMIT\")\" = '$A2_GIT_COMMIT'
(cd \"\$STAGE\" && sha256sum --check --strict SOURCE_SHA256SUMS)
mv -T \"\$STAGE\" \"\$WORKSPACE\"
rm -f '$REMOTE_UPLOAD'"
```

`workspace-a-r2` is never updated in place.

## 3. Authority and grant: preview twice, apply once

Verify the existing authority twice without writes. Then run the grant preview
twice and require byte identity. Only then run grant `--apply` once. Never loop
or blindly retry the apply command.

```zsh
"${SSH_INNER[@]}" 'bash -se' <<'REMOTE'
set -euo pipefail
umask 077
RUN_ROOT=/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess
WORKSPACE="$RUN_ROOT/workspace-a-r2"
INPUT="$RUN_ROOT/input/pdfs-verified"
MANIFEST="$RUN_ROOT/manifests/offload-shard-a.json"
A1="$RUN_ROOT/output/production-p4-mb16-shard-a-r1"
AUTHORITY="$RUN_ROOT/input/timeout-recovery-authority-v1"
EVIDENCE=$(cat "$RUN_ROOT/.a2-current-evidence")

node "$WORKSPACE/scripts/provision-timeout-recovery-authority.mjs" \
  --input-root "$INPUT" > "$EVIDENCE/authority-preview-1.json"
node "$WORKSPACE/scripts/provision-timeout-recovery-authority.mjs" \
  --input-root "$INPUT" > "$EVIDENCE/authority-preview-2.json"
cmp "$EVIDENCE/authority-preview-1.json" "$EVIDENCE/authority-preview-2.json"

node "$WORKSPACE/scripts/prepare-timeout-recovery-grant.mjs" \
  --manifest "$MANIFEST" --predecessor-root "$A1" \
  --ledger-root "$AUTHORITY" > "$EVIDENCE/grant-preview-1.json"
node "$WORKSPACE/scripts/prepare-timeout-recovery-grant.mjs" \
  --manifest "$MANIFEST" --predecessor-root "$A1" \
  --ledger-root "$AUTHORITY" > "$EVIDENCE/grant-preview-2.json"
cmp "$EVIDENCE/grant-preview-1.json" "$EVIDENCE/grant-preview-2.json"

# One apply, once, after two identical previews.
node "$WORKSPACE/scripts/prepare-timeout-recovery-grant.mjs" \
  --manifest "$MANIFEST" --predecessor-root "$A1" \
  --ledger-root "$AUTHORITY" --apply > "$EVIDENCE/grant-apply-once.json"

# All pre-existing A1 bytes remain unchanged. Only no-replace incident,
# issuance, and grant files may have been added.
(cd "$A1" && sha256sum --check --strict "$EVIDENCE/a1-pregrant.SHA256SUMS")
(cd "$A1" && sha256sum --check --strict timeout-recovery-grant.json.sha256)
sha256sum "$EVIDENCE/authority-preview-1.json" \
  "$EVIDENCE/grant-preview-1.json" "$EVIDENCE/grant-apply-once.json" \
  > "$EVIDENCE/authority-grant-evidence.SHA256SUMS"
REMOTE
```

Grant issuance is an **irreversible authority boundary**. An authority or
predecessor snapshot must not be restored afterward, even if device and inode
appear unchanged. Loss, rollback, or drift freezes the lineage; this protocol
has no reissue escape hatch.

## 4. Compute `a1-anchors.env` and final `SHA256SUMS`

The exact reviewed monitor computes all five A1 anchors. The exclusive
owner-only environment file then becomes part of the final workspace seal.

```zsh
"${SSH_INNER[@]}" 'bash -se' <<'REMOTE'
set -euo pipefail
umask 077
RUN_ROOT=/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess
WORKSPACE="$RUN_ROOT/workspace-a-r2"
A1="$RUN_ROOT/output/production-p4-mb16-shard-a-r1"
ANCHORS="$WORKSPACE/a1-anchors.env"
EVIDENCE=$(cat "$RUN_ROOT/.a2-current-evidence")
test ! -e "$ANCHORS"

A1_ROOT="$A1" ANCHOR_FILE="$ANCHORS" \
MONITOR_MODULE="$WORKSPACE/scripts/monitor-remote-ocr-single-shard.mjs" \
node --input-type=module <<'NODE'
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { inspectPredecessorB1 } = await import(pathToFileURL(process.env.MONITOR_MODULE));
const snapshot = await inspectPredecessorB1(process.env.A1_ROOT);
const mapping = [
  ['BDFZ_OCR_A1_IDENTITY_SHA256', 'identity_sha256'],
  ['BDFZ_OCR_A1_RUN_STATUS_SHA256', 'run_status_sha256'],
  ['BDFZ_OCR_A1_STATE_HASHSET_SHA256', 'state_hashset_sha256'],
  ['BDFZ_OCR_A1_STATUS_HASHSET_SHA256', 'status_hashset_sha256'],
  ['BDFZ_OCR_A1_ARTIFACT_HASHSET_SHA256', 'artifact_hashset_sha256'],
];
const lines = mapping.map(([name, key]) => {
  const value = snapshot.anchors[key];
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${key} is invalid`);
  return `${name}=${value}`;
});
const handle = await open(process.env.ANCHOR_FILE, 'wx', 0o600);
try {
  await handle.writeFile(`${lines.join('\n')}\n`);
  await handle.sync();
} finally {
  await handle.close();
}
NODE

test "$(wc -l < "$ANCHORS")" -eq 5
test "$(grep -Ec '^BDFZ_OCR_A1_[A-Z0-9_]+=[a-f0-9]{64}$' "$ANCHORS")" -eq 5
(
  cd "$WORKSPACE"
  find . -type f ! -name SHA256SUMS -print0 \
    | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS
  sha256sum --check --strict SHA256SUMS
)
sha256sum "$WORKSPACE/SHA256SUMS" > "$EVIDENCE/workspace-SHA256SUMS.sha256"
cp "$ANCHORS" "$EVIDENCE/a1-anchors.env"
sha256sum "$EVIDENCE/a1-anchors.env" > "$EVIDENCE/a1-anchors.env.sha256"
find "$WORKSPACE" -type f -exec chmod 0400 {} +
find "$WORKSPACE" -type d -exec chmod 0500 {} +
(cd "$WORKSPACE" && sha256sum --check --strict SHA256SUMS)
REMOTE
```

## 5. Create the exact successor inode, monitor directory, and stable cache

The consumption claim binds the A2 path, filesystem device, and inode. Create
it once, copy the stable PaddleX cache without hard links, and prove byte
equality before seed preview. The monitor unit cannot create its own output
root under `ProtectSystem=strict`; create one new private real directory before
the worker can start.

```zsh
"${SSH_INNER[@]}" 'bash -se' <<'REMOTE'
set -euo pipefail
umask 077
RUN_ROOT=/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess
A1="$RUN_ROOT/output/production-p4-mb16-shard-a-r1"
A2="$RUN_ROOT/output/production-p1-mb16-shard-a-r2"
MONITOR_DIR="$RUN_ROOT/monitor-a-r2"
LOCK="$RUN_ROOT/.a2-lifecycle.lock"
EVIDENCE=$(cat "$RUN_ROOT/.a2-current-evidence")
test ! -e "$A2"
test ! -e "$MONITOR_DIR"
test ! -L "$MONITOR_DIR"
test ! -e "$LOCK"
mkdir -m 700 "$A2"
mkdir -m 700 "$MONITOR_DIR"
test -d "$MONITOR_DIR"
test ! -L "$MONITOR_DIR"
test "$(stat -c %a "$MONITOR_DIR")" = 700
test "$(stat -c %u "$MONITOR_DIR")" = "$(id -u)"
(set -o noclobber; : > "$LOCK")
chmod 600 "$LOCK"
cp -a --reflink=auto "$A1/paddlex-cache" "$A2/paddlex-cache"
test ! -L "$A2/paddlex-cache"
(
  cd "$A1/paddlex-cache"
  find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
) > "$EVIDENCE/a1-paddlex-cache.SHA256SUMS"
(cd "$A2/paddlex-cache" && sha256sum --check --strict "$EVIDENCE/a1-paddlex-cache.SHA256SUMS")
stat -c 'output_device=%d output_inode=%i mode=%a owner=%u:%g' "$A2" \
  > "$EVIDENCE/a2-output-inode.txt"
stat -c 'lock_device=%d lock_inode=%i mode=%a owner=%u:%g' "$LOCK" \
  > "$EVIDENCE/a2-lifecycle-lock.txt"
stat -c 'monitor_device=%d monitor_inode=%i mode=%a owner=%u:%g' "$MONITOR_DIR" \
  > "$EVIDENCE/a2-monitor-directory.txt"
REMOTE
```

Do not remove or recreate this directory after seed preparation begins.

## 6. Install units and run `systemd-analyze --user verify`

First stop the completed B-r3 monitor and its retry timer so the shared alert
chain cannot execute while it is replaced. Install order is llama, reviewed
alert handler, reviewed retry timer, hash-sealed notifier runtime, cleanup,
worker, monitor, monitor drop-in, monitor timer, cleanup config, and A2 alert
binding. Every shared alert artifact is exact-compared with the reviewed tree.
The delivery credential is checked only for owner/mode; its contents are never
read or printed.

```zsh
"${SSH_INNER[@]}" 'bash -se' <<'REMOTE'
set -euo pipefail
umask 077
RUN_ROOT=/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess
WORKSPACE="$RUN_ROOT/workspace-a-r2"
SYSTEMD_USER="$HOME/.config/systemd/user"
CONFIG="$HOME/.config/bdfz"
ALERT_STATE="$HOME/.local/state/bdfz-curriculum-ocr-monitor-alert"
ALERT_RUNTIME="$HOME/curriculum-ocr-offload/alert-runtime"
EVIDENCE=$(cat "$RUN_ROOT/.a2-current-evidence")
mkdir -p "$SYSTEMD_USER/curriculum-ocr-reprocess-a-r2-monitor.service.d"
for private_dir in "$CONFIG" "$ALERT_STATE"; do
  test -d "$private_dir"
  test ! -L "$private_dir"
  test "$(stat -c %a "$private_dir")" = 700
  test "$(stat -c %u "$private_dir")" = "$(id -u)"
done
if ! test -d "$ALERT_RUNTIME"; then
  mkdir -m 700 "$ALERT_RUNTIME"
fi
test -d "$ALERT_RUNTIME"
test ! -L "$ALERT_RUNTIME"
test "$(stat -c %a "$ALERT_RUNTIME")" = 700
test "$(stat -c %u "$ALERT_RUNTIME")" = "$(id -u)"

# The shared handler and retry chain must be quiescent before replacement.
systemctl --user disable --now curriculum-ocr-reprocess-b-r3-monitor.timer
systemctl --user disable --now \
  curriculum-ocr-monitor-alert-retry@curriculum-ocr-reprocess-b-r3-monitor.service.timer
for quiet_unit in \
  curriculum-ocr-reprocess-b-r3-monitor.service \
  curriculum-ocr-monitor-alert@curriculum-ocr-reprocess-b-r3-monitor.service.service; do
  test "$(systemctl --user show "$quiet_unit" --property=ActiveState --value)" = inactive
  test "$(systemctl --user show "$quiet_unit" --property=MainPID --value)" = 0
done

install -m 0644 "$WORKSPACE/ops/systemd/curriculum-ocr-llama.service" \
  "$SYSTEMD_USER/curriculum-ocr-llama.service"
install -m 0644 "$WORKSPACE/ops/systemd/curriculum-ocr-monitor-alert@.service" \
  "$SYSTEMD_USER/curriculum-ocr-monitor-alert@.service"
install -m 0644 "$WORKSPACE/ops/systemd/curriculum-ocr-monitor-alert-retry@.timer" \
  "$SYSTEMD_USER/curriculum-ocr-monitor-alert-retry@.timer"
install -m 0400 "$WORKSPACE/scripts/notify-remote-ocr-single-shard-monitor.mjs" \
  "$ALERT_RUNTIME/notify-remote-ocr-single-shard-monitor.mjs"
cmp "$WORKSPACE/ops/systemd/curriculum-ocr-monitor-alert@.service" \
  "$SYSTEMD_USER/curriculum-ocr-monitor-alert@.service"
cmp "$WORKSPACE/ops/systemd/curriculum-ocr-monitor-alert-retry@.timer" \
  "$SYSTEMD_USER/curriculum-ocr-monitor-alert-retry@.timer"
cmp "$WORKSPACE/scripts/notify-remote-ocr-single-shard-monitor.mjs" \
  "$ALERT_RUNTIME/notify-remote-ocr-single-shard-monitor.mjs"
NOTIFIER_SHA=$(sha256sum "$WORKSPACE/scripts/notify-remote-ocr-single-shard-monitor.mjs" \
  | awk '{print $1}')
test "$(sha256sum "$ALERT_RUNTIME/notify-remote-ocr-single-shard-monitor.mjs" \
  | awk '{print $1}')" = "$NOTIFIER_SHA"
printf '%s  %s\n' "$NOTIFIER_SHA" \
  "$ALERT_RUNTIME/notify-remote-ocr-single-shard-monitor.mjs" \
  > "$EVIDENCE/alert-runtime.SHA256SUMS"
install -m 0400 "$EVIDENCE/alert-runtime.SHA256SUMS" \
  "$ALERT_RUNTIME/SHA256SUMS"
(cd "$ALERT_RUNTIME" && sha256sum --check --strict SHA256SUMS)

install -m 0644 "$WORKSPACE/ops/systemd/curriculum-ocr-reprocess-a-r2-cleanup.service" \
  "$SYSTEMD_USER/curriculum-ocr-reprocess-a-r2-cleanup.service"
install -m 0644 "$WORKSPACE/ops/systemd/curriculum-ocr-reprocess-a-r2.service" \
  "$SYSTEMD_USER/curriculum-ocr-reprocess-a-r2.service"
install -m 0644 "$WORKSPACE/ops/systemd/curriculum-ocr-reprocess-a-r2-monitor.service" \
  "$SYSTEMD_USER/curriculum-ocr-reprocess-a-r2-monitor.service"
install -m 0644 "$WORKSPACE/ops/systemd/curriculum-ocr-reprocess-a-r2-monitor.service.d/alert-only.conf" \
  "$SYSTEMD_USER/curriculum-ocr-reprocess-a-r2-monitor.service.d/alert-only.conf"
install -m 0644 "$WORKSPACE/ops/systemd/curriculum-ocr-reprocess-a-r2-monitor.timer" \
  "$SYSTEMD_USER/curriculum-ocr-reprocess-a-r2-monitor.timer"
install -m 0600 "$WORKSPACE/ops/systemd/curriculum-ocr-reprocess-a-r2-cleanup.conf.example" \
  "$CONFIG/curriculum-ocr-reprocess-a-r2-cleanup.conf"

MONITOR_SHA=$(sha256sum "$WORKSPACE/scripts/monitor-remote-ocr-single-shard.mjs" | awk '{print $1}')
# The shared alert config can bind only one live lineage.
sed "s/<LOWERCASE_64_HEX_SHA256>/$MONITOR_SHA/" \
  "$WORKSPACE/ops/systemd/curriculum-ocr-reprocess-a-r2-monitor-alert.conf.example" \
  > "$EVIDENCE/curriculum-ocr-monitor-alert.conf"
! grep -q '<LOWERCASE_64_HEX_SHA256>' "$EVIDENCE/curriculum-ocr-monitor-alert.conf"
install -m 0600 "$EVIDENCE/curriculum-ocr-monitor-alert.conf" \
  "$CONFIG/curriculum-ocr-monitor-alert.conf"

test -f "$CONFIG/curriculum-ocr-monitor-telegram.env"
test "$(stat -c %a "$CONFIG/curriculum-ocr-monitor-telegram.env")" = 600
test "$(stat -c %u "$CONFIG/curriculum-ocr-monitor-telegram.env")" = "$(id -u)"
(cd "$ALERT_RUNTIME" && sha256sum --check --strict SHA256SUMS)

systemctl --user daemon-reload
systemd-analyze --user verify \
  "$SYSTEMD_USER/curriculum-ocr-llama.service" \
  "$SYSTEMD_USER/curriculum-ocr-monitor-alert@.service" \
  "$SYSTEMD_USER/curriculum-ocr-monitor-alert-retry@.timer" \
  "$SYSTEMD_USER/curriculum-ocr-reprocess-a-r2-cleanup.service" \
  "$SYSTEMD_USER/curriculum-ocr-reprocess-a-r2.service" \
  "$SYSTEMD_USER/curriculum-ocr-reprocess-a-r2-monitor.service" \
  "$SYSTEMD_USER/curriculum-ocr-reprocess-a-r2-monitor.timer"
! systemctl --user cat curriculum-ocr-reprocess-a-r2.service \
  | grep -Eq '^Condition(Path|File)'
systemctl --user cat curriculum-ocr-reprocess-a-r2.service \
  > "$EVIDENCE/curriculum-ocr-reprocess-a-r2.service.installed.txt"
systemctl --user cat curriculum-ocr-reprocess-a-r2-monitor.service \
  > "$EVIDENCE/curriculum-ocr-reprocess-a-r2-monitor.service.installed.txt"
REMOTE
```

Any static verify error or mismatch stops the release. Never weaken an
`ExecStartPre` prerequisite to make the unit appear successful.

## 7. Seed dry-run twice, apply once, and prove idempotence

Start only the exact loopback llama unit. The two `--seed-dry-run` outputs must
be byte-identical. The first `--seed-only` consumes the one grant and commits
the seed. The second is an exact idempotence/readback check, not another apply.

```zsh
"${SSH_INNER[@]}" 'bash -se' <<'REMOTE'
set -euo pipefail
umask 077
RUN_ROOT=/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess
WORKSPACE="$RUN_ROOT/workspace-a-r2"
A1="$RUN_ROOT/output/production-p4-mb16-shard-a-r1"
A2="$RUN_ROOT/output/production-p1-mb16-shard-a-r2"
AUTHORITY="$RUN_ROOT/input/timeout-recovery-authority-v1"
EVIDENCE=$(cat "$RUN_ROOT/.a2-current-evidence")

systemctl --user start curriculum-ocr-llama.service
for attempt in $(seq 1 60); do
  if curl --fail --silent --show-error --connect-timeout 1 --max-time 2 \
    http://127.0.0.1:8112/health; then
    break
  fi
  test "$attempt" -lt 60
  sleep 1
done

SEED_ARGS=(
  --manifest "$RUN_ROOT/manifests/offload-shard-a.json"
  --input-root "$RUN_ROOT/input/pdfs-verified"
  --output-root "$A2"
  --python /home/suen/curriculum-ocr-offload/runs/20260716T0250Z-paddleocrvl16-canary/venv/bin/python
  --ocr-script "$WORKSPACE/scripts/ocr-pdf-paddle.py"
  --model /home/suen/curriculum-ocr-offload/runs/20260716T0250Z-paddleocrvl16-canary/models/PaddleOCR-VL-1.6-GGUF.gguf
  --mmproj /home/suen/curriculum-ocr-offload/runs/20260716T0250Z-paddleocrvl16-canary/models/PaddleOCR-VL-1.6-GGUF-mmproj.gguf
  --llama-repo /home/suen/curriculum-ocr-offload/runs/20260716T0250Z-paddleocrvl16-canary/src/llama.cpp
  --llama-server-bin /home/suen/curriculum-ocr-offload/runs/20260716T0250Z-paddleocrvl16-canary/src/llama.cpp/build-cuda/bin/llama-server
  --llama-systemd-unit curriculum-ocr-llama.service
  --llama-url http://127.0.0.1:8112/v1
  --runtime-device "cpu+NVIDIA RTX 3060 Laptop GPU CUDA llama.cpp"
  --vl-rec-max-concurrency 1
  --server-parallel 1
  --micro-batch 16
  --use-queues
  --paddlex-cache-home "$A2/paddlex-cache"
  --seed-from-output-root "$A1"
  --timeout-recovery-ledger "$AUTHORITY"
  --child-startup-timeout-seconds 180
  --child-idle-timeout-seconds 1200
  --child-wall-floor-seconds 1200
  --child-wall-seconds-per-page 25
  --child-terminate-grace-seconds 15
  --child-poll-interval-seconds 5
)

node "$WORKSPACE/scripts/run-remote-ocr-offload.mjs" "${SEED_ARGS[@]}" \
  --seed-dry-run > "$EVIDENCE/seed-preview-1.json"
node "$WORKSPACE/scripts/run-remote-ocr-offload.mjs" "${SEED_ARGS[@]}" \
  --seed-dry-run > "$EVIDENCE/seed-preview-2.json"
cmp "$EVIDENCE/seed-preview-1.json" "$EVIDENCE/seed-preview-2.json"
jq -e '.seed_dry_run == true and (.seed_id | test("^[a-f0-9]{64}$"))' \
  "$EVIDENCE/seed-preview-1.json"

# Irreversible claim and seed commit: one apply.
node "$WORKSPACE/scripts/run-remote-ocr-offload.mjs" "${SEED_ARGS[@]}" \
  --seed-only > "$EVIDENCE/seed-apply-once.json"
node "$WORKSPACE/scripts/run-remote-ocr-offload.mjs" "${SEED_ARGS[@]}" \
  --seed-only > "$EVIDENCE/seed-idempotence-readback.json"
cmp "$EVIDENCE/seed-apply-once.json" "$EVIDENCE/seed-idempotence-readback.json"

for basename in seed-commit.json seed-receipt.json run-status.json \
  timeout-recovery-grant.json timeout-recovery-consumption-claim.json; do
  (cd "$A2" && sha256sum --check --strict "$basename.sha256")
done
find "$AUTHORITY" -maxdepth 1 -type f -name '*.claim.json' -print \
  > "$EVIDENCE/authority-claims-after-seed.txt"
test "$(wc -l < "$EVIDENCE/authority-claims-after-seed.txt")" -eq 1
sha256sum "$A2/seed-commit.json" "$A2/seed-receipt.json" "$A2/run-status.json" \
  > "$EVIDENCE/seed-readback.SHA256SUMS"
REMOTE
```

Do not recreate the successor if any seed step fails. Freeze the same inode and
preserve the claim, receipt, sidecars, stage remnants, and command outputs.

## 8. Start order, monitor canary, and alert rebinding

The only supported order is worker enable, worker start, two distinct manual
monitor canaries, armed-receipt validation, monitor timer enable, then alert
retry timer enable. Never enable timers before a healthy live worker.

```zsh
"${SSH_INNER[@]}" 'bash -se' <<'REMOTE'
set -euo pipefail
RUN_ROOT=/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess
A2="$RUN_ROOT/output/production-p1-mb16-shard-a-r2"
MONITOR_JSON="$RUN_ROOT/monitor-a-r2/latest.json"
ALERT_STATE="$HOME/.local/state/bdfz-curriculum-ocr-monitor-alert"
EVIDENCE=$(cat "$RUN_ROOT/.a2-current-evidence")

systemctl --user enable curriculum-ocr-reprocess-a-r2.service
systemctl --user start curriculum-ocr-reprocess-a-r2.service
STATE=$(systemctl --user show curriculum-ocr-reprocess-a-r2.service \
  --property=ActiveState --value)
PID=$(systemctl --user show curriculum-ocr-reprocess-a-r2.service \
  --property=MainPID --value)
CONDITION=$(systemctl --user show curriculum-ocr-reprocess-a-r2.service \
  --property=ConditionResult --value)
RESTARTS=$(systemctl --user show curriculum-ocr-reprocess-a-r2.service \
  --property=NRestarts --value)
test "$STATE" = active
test "$PID" -gt 1
test "$CONDITION" != no
test "$RESTARTS" -eq 0
systemctl --user show curriculum-ocr-reprocess-a-r2.service \
  --property=LoadState --property=UnitFileState --property=ActiveState \
  --property=SubState --property=MainPID --property=ConditionResult \
  --property=InvocationID --property=NRestarts --property=Result --no-pager \
  > "$EVIDENCE/a2-worker-start.txt"

systemctl --user start curriculum-ocr-reprocess-a-r2-monitor.service
INVOCATION_1=$(systemctl --user show curriculum-ocr-reprocess-a-r2-monitor.service \
  --property=InvocationID --value)
jq -e '.state == "healthy_running" and .exit_code == 10 and (.issue_codes | length) == 0' \
  "$MONITOR_JSON"
sleep 2
systemctl --user start curriculum-ocr-reprocess-a-r2-monitor.service
INVOCATION_2=$(systemctl --user show curriculum-ocr-reprocess-a-r2-monitor.service \
  --property=InvocationID --value)
test -n "$INVOCATION_1"
test -n "$INVOCATION_2"
test "$INVOCATION_1" != "$INVOCATION_2"
jq -e '.state == "healthy_running" and .exit_code == 10 and (.issue_codes | length) == 0' \
  "$MONITOR_JSON"
jq -e '
  .schema_version == 2 and
  .type == "curriculum_ocr_monitor_alert_armed_receipt" and
  (.observations | length) == 2 and
  ([.observations[].monitor_invocation_id] | unique | length) == 2
' "$ALERT_STATE/armed-receipt.json"

systemctl --user enable --now curriculum-ocr-reprocess-a-r2-monitor.timer
systemctl --user enable --now \
  curriculum-ocr-monitor-alert-retry@curriculum-ocr-reprocess-a-r2-monitor.service.timer
systemctl --user list-timers --all --no-pager \
  | grep -E 'curriculum-ocr-reprocess-a-r2-monitor|curriculum-ocr-monitor-alert-retry'

(cd "$A2" && sha256sum --check --strict run-status.json.sha256)
jq -e '
  .citation_allowed == false and .counts.failed == 0 and
  .counts.quarantined == 0 and .counts.running <= 1
' "$A2/run-status.json"
cp "$MONITOR_JSON" "$EVIDENCE/monitor-canary-2.json"
REMOTE
```

## 9. Progress checks and immediate freeze

Poll at the two-minute monitor cadence. GPU utilization alone is not progress:

```bash
RUN_ROOT=/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess
A2="$RUN_ROOT/output/production-p1-mb16-shard-a-r2"
systemctl --user show curriculum-ocr-reprocess-a-r2.service \
  --property=ActiveState --property=SubState --property=MainPID \
  --property=ConditionResult --property=NRestarts --property=Result --no-pager
(cd "$A2" && sha256sum --check --strict run-status.json.sha256)
jq '{finished,settled,counts,updated_at,citation_allowed}' "$A2/run-status.json"
jq '{state,exit_code,issue_codes,successor,services,resources}' \
  "$RUN_ROOT/monitor-a-r2/latest.json"
nvidia-smi
df -hT /
free -h
```

Healthy running means `ActiveState=active`, nonzero `MainPID`,
`ConditionResult` not false, `NRestarts=0`, valid hashes, no failed or
quarantined documents, advancing completed pages, and monitor exit 10 with no
issue. Completion means monitor exit 0, every document complete, worker
inactive/dead with `MainPID=0`, worker disabled by cleanup, llama inactive/dead,
and all hashes valid.

On any integrity, restart, thermal, memory, disk, alert, or progress failure,
freeze only task-owned units and preserve all evidence:

```bash
systemctl --user disable --now curriculum-ocr-reprocess-a-r2-monitor.timer
systemctl --user disable --now \
  curriculum-ocr-monitor-alert-retry@curriculum-ocr-reprocess-a-r2-monitor.service.timer
systemctl --user disable --now curriculum-ocr-reprocess-a-r2.service
systemctl --user stop curriculum-ocr-llama.service
systemctl --user show curriculum-ocr-reprocess-a-r2.service \
  --property=ActiveState --property=SubState --property=MainPID \
  --property=InvocationID --property=NRestarts --property=Result --no-pager
```

Never delete A1, A2, the lifecycle lock, authority, issuance, claim, logs, or
monitor state. Never start a new output root to evade a consumed claim.

## 10. Completion archive and local readback

After cleanup disables the worker and stops llama, disable both timers and
revalidate terminal state. Create a deterministic private archive. A remains
staging-only and must not be imported alone; publication requires the exact
reviewed A+B union.

Run on inner `bdfz`:

```bash
set -euo pipefail
umask 077
RUN_ROOT=/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess
A2_REL=output/production-p1-mb16-shard-a-r2
A2="$RUN_ROOT/$A2_REL"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE_DIR=/home/suen/curriculum-ocr-offload/archives
ARCHIVE="$ARCHIVE_DIR/$STAMP-production-p1-mb16-shard-a-r2-final.tar.zst"

systemctl --user disable --now curriculum-ocr-reprocess-a-r2-monitor.timer
systemctl --user disable --now \
  curriculum-ocr-monitor-alert-retry@curriculum-ocr-reprocess-a-r2-monitor.service.timer
test "$(systemctl --user show curriculum-ocr-reprocess-a-r2.service --property=ActiveState --value)" = inactive
test "$(systemctl --user show curriculum-ocr-reprocess-a-r2.service --property=MainPID --value)" = 0
test "$(systemctl --user is-enabled curriculum-ocr-reprocess-a-r2.service)" = disabled
test "$(systemctl --user show curriculum-ocr-llama.service --property=ActiveState --value)" = inactive
(cd "$A2" && sha256sum --check --strict run-status.json.sha256)
jq -e '
  .finished == true and .settled == true and
  .counts.total == .counts.complete and
  ([.counts.failed,.counts.interrupted,.counts.pending,.counts.running,.counts.retry_wait,.counts.quarantined] | add) == 0 and
  .citation_allowed == false
' "$A2/run-status.json"

mkdir -p -m 700 "$ARCHIVE_DIR"
TREE_MANIFEST="$ARCHIVE_DIR/$STAMP-production-p1-mb16-shard-a-r2-tree.SHA256SUMS"
(cd "$A2" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) \
  > "$TREE_MANIFEST"
chmod 600 "$TREE_MANIFEST"
(cd "$ARCHIVE_DIR" && sha256sum "$(basename "$TREE_MANIFEST")" \
  > "$(basename "$TREE_MANIFEST").sha256")
chmod 600 "$TREE_MANIFEST.sha256"
tar --sort=name --mtime='UTC 1970-01-01' --numeric-owner --owner=0 --group=0 \
  -I 'zstd -10 -T0' -cf "$ARCHIVE" -C "$RUN_ROOT" "$A2_REL" monitor-a-r2
chmod 600 "$ARCHIVE"
(cd "$ARCHIVE_DIR" && sha256sum "$(basename "$ARCHIVE")" \
  > "$(basename "$ARCHIVE").sha256")
chmod 600 "$ARCHIVE.sha256"
(cd "$ARCHIVE_DIR" && sha256sum --check --strict "$(basename "$ARCHIVE").sha256")
tar -I zstd -tf "$ARCHIVE" > "$ARCHIVE.contents.txt"
chmod 600 "$ARCHIVE.contents.txt"
printf '%s\n' "$ARCHIVE"
printf '%s\n' "$TREE_MANIFEST"
```

Use the printed path for exact local readback on the Mac:

```zsh
REMOTE_ARCHIVE="<REMOTE_A2_ARCHIVE_PATH>"
REMOTE_TREE_MANIFEST="${REMOTE_ARCHIVE%-final.tar.zst}-tree.SHA256SUMS"
READBACK=/Users/ylsuen/CF/curriculum-atlas/.cache/remote-ocr-offload/$(date -u +%Y%m%dT%H%M%SZ)-a2-final
mkdir -p -m 700 "$READBACK"
"${SCP_INNER[@]}" "suen@localhost:$REMOTE_ARCHIVE" \
  "suen@localhost:$REMOTE_ARCHIVE.sha256" \
  "suen@localhost:$REMOTE_TREE_MANIFEST" \
  "suen@localhost:$REMOTE_TREE_MANIFEST.sha256" "$READBACK/"
(
  cd "$READBACK"
  sha256sum --check --strict "$(basename "$REMOTE_ARCHIVE").sha256"
  sha256sum --check --strict "$(basename "$REMOTE_TREE_MANIFEST").sha256"
  mkdir extracted
  tar -I zstd -xf "$(basename "$REMOTE_ARCHIVE")" -C extracted
  A2_READBACK="$READBACK/extracted/output/production-p1-mb16-shard-a-r2"
  (cd "$A2_READBACK" && sha256sum --check --strict run-status.json.sha256)
  (cd "$A2_READBACK" && sha256sum --check --strict \
    "$READBACK/$(basename "$REMOTE_TREE_MANIFEST")")
  jq -e '.finished == true and .counts.total == .counts.complete and .citation_allowed == false' \
    "$A2_READBACK/run-status.json"
)
```

Record remote/local archive SHA-256, bytes, `run-status.json` SHA-256, tree
hash, and readback result. Do not use receiver `--apply` before exact A+B
paired-union dry-run succeeds.

## 11. Rollback and irreversible boundary

Before grant issuance, rollback may restore backed-up unit, config, notifier,
manifest, and runtime-directory state. After issuance or consumption, rollback
means **freeze** and restore only that runtime presentation; it never rewinds
OCR evidence or authority. The A2 successor, monitor evidence directory, alert
state, lifecycle lock, grant, claim, and deployment evidence remain preserved.

```bash
set -euo pipefail
RUN_ROOT=/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess
BACKUP=$(cat "$RUN_ROOT/.a2-current-backup")
ALERT_RUNTIME="$HOME/curriculum-ocr-offload/alert-runtime"
systemctl --user disable --now curriculum-ocr-reprocess-a-r2-monitor.timer || true
systemctl --user disable --now \
  curriculum-ocr-monitor-alert-retry@curriculum-ocr-reprocess-a-r2-monitor.service.timer || true
systemctl --user disable --now curriculum-ocr-reprocess-a-r2.service || true
systemctl --user stop curriculum-ocr-reprocess-a-r2-monitor.service || true
systemctl --user stop \
  curriculum-ocr-monitor-alert@curriculum-ocr-reprocess-a-r2-monitor.service.service || true
systemctl --user stop curriculum-ocr-llama.service || true
for quiet_unit in \
  curriculum-ocr-reprocess-a-r2-monitor.service \
  curriculum-ocr-monitor-alert@curriculum-ocr-reprocess-a-r2-monitor.service.service; do
  test "$(systemctl --user show "$quiet_unit" --property=ActiveState --value)" = inactive
  test "$(systemctl --user show "$quiet_unit" --property=MainPID --value)" = 0
done

while IFS=$'\t' read -r state relative; do
  target="$HOME/$relative"
  if test "$state" = present; then
    mkdir -p "$(dirname "$target")"
    rm -f -- "$target"
    cp -a --no-dereference "$BACKUP/files/$relative" "$target"
  else
    rm -f -- "$target"
  fi
done < "$BACKUP/file-state.tsv"

ALERT_RUNTIME_STATE=$(sed -n 's/^state=//p' "$BACKUP/alert-runtime-state.env")
case "$ALERT_RUNTIME_STATE" in
  present)
    test -d "$ALERT_RUNTIME"
    test ! -L "$ALERT_RUNTIME"
    test "$(stat -c %a "$ALERT_RUNTIME")" = 700
    test "$(stat -c %u "$ALERT_RUNTIME")" = "$(id -u)"
    ;;
  absent)
    test ! -e "$ALERT_RUNTIME/notify-remote-ocr-single-shard-monitor.mjs"
    test ! -e "$ALERT_RUNTIME/SHA256SUMS"
    rmdir "$ALERT_RUNTIME"
    ;;
  *)
    echo 'invalid saved alert-runtime state' >&2
    exit 1
    ;;
esac
if grep -Fqx $'present\tcurriculum-ocr-offload/alert-runtime/SHA256SUMS' \
  "$BACKUP/file-state.tsv"; then
  (cd "$ALERT_RUNTIME" && sha256sum --check --strict SHA256SUMS)
fi

systemctl --user daemon-reload

B3_MONITOR_STATE=$(sed -n 's/^b3_monitor_timer=//p' "$BACKUP/b3-timer-state.env")
B3_ALERT_STATE=$(sed -n 's/^b3_alert_retry_timer=//p' "$BACKUP/b3-timer-state.env")
restore_timer_state() {
  state=$1
  unit=$2
  case "$state" in
    enabled) systemctl --user enable --now "$unit" ;;
    enabled-runtime) systemctl --user enable --runtime --now "$unit" ;;
    disabled) systemctl --user disable --now "$unit" ;;
    *) echo "invalid saved timer state for $unit" >&2; return 1 ;;
  esac
}
restore_timer_state "$B3_MONITOR_STATE" \
  curriculum-ocr-reprocess-b-r3-monitor.timer
restore_timer_state "$B3_ALERT_STATE" \
  curriculum-ocr-monitor-alert-retry@curriculum-ocr-reprocess-b-r3-monitor.service.timer

systemctl --user show curriculum-ocr-reprocess-a-r2.service \
  --property=LoadState --property=UnitFileState --property=ActiveState \
  --property=SubState --property=MainPID --property=NRestarts --no-pager
```

If a grant or claim exists, the authority or predecessor must not be restored,
the successor inode must not be replaced, the claim must not be removed, and a
second grant must not be issued. Preserve the frozen lineage and require a new
independent audit for any forward repair.
