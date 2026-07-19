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
(
  set -euo pipefail
  umask 077
  export COPYFILE_DISABLE=1
  typeset -a MAC_TAR
  MAC_TAR=(tar --no-mac-metadata --no-xattrs)

  assert_no_appledouble() {
    local root=$1
    test -z "$(find "$root" -type f -name '._*' -print -quit)"
  }

  assert_exact_source_tree() {
    local root=$1
    local actual=$2
    (
      cd "$root"
      find . -type f ! -name SOURCE_SHA256SUMS -print0 \
        | LC_ALL=C sort -z | xargs -0 sha256sum > "$actual"
      cmp SOURCE_SHA256SUMS "$actual"
    )
  }

  LOCAL_STAGE=$(mktemp -d /private/tmp/curriculum-a2-source.XXXXXX)
  LOCAL_TAR="$LOCAL_STAGE.tar"
  LOCAL_ACTUAL_SOURCE_SHA="$LOCAL_STAGE.actual.SOURCE_SHA256SUMS"
  trap 'rm -rf "$LOCAL_STAGE" "$LOCAL_TAR" "$LOCAL_ACTUAL_SOURCE_SHA"' \
    EXIT INT TERM

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
    | "${MAC_TAR[@]}" -xf - -C "$LOCAL_STAGE"

  printf '%s\n' "$A2_GIT_COMMIT" > "$LOCAL_STAGE/SOURCE_COMMIT"
  (
    cd "$LOCAL_STAGE"
    find . -type f ! -name SOURCE_SHA256SUMS -print0 \
      | LC_ALL=C sort -z | xargs -0 sha256sum > SOURCE_SHA256SUMS
    sha256sum --check --strict SOURCE_SHA256SUMS
  )
  assert_no_appledouble "$LOCAL_STAGE"
  assert_exact_source_tree "$LOCAL_STAGE" "$LOCAL_ACTUAL_SOURCE_SHA"

  "${MAC_TAR[@]}" -C "$LOCAL_STAGE" -cf "$LOCAL_TAR" .
  if tar -tf "$LOCAL_TAR" | LC_ALL=C grep -Eq '(^|/)\._'; then
    echo 'local A2 archive contains forbidden AppleDouble entries' >&2
    exit 1
  fi
  LOCAL_TAR_SHA=$(sha256sum "$LOCAL_TAR" | awk '{print $1}')

  REMOTE_UPLOAD=/home/suen/curriculum-ocr-offload/staging/$(basename "$LOCAL_TAR")
  "${SSH_INNER[@]}" 'mkdir -p -m 700 /home/suen/curriculum-ocr-offload/staging'
  "${SCP_INNER[@]}" "$LOCAL_TAR" "suen@localhost:$REMOTE_UPLOAD"
  "${SSH_INNER[@]}" bash -se -- \
    "$REMOTE_UPLOAD" "$LOCAL_TAR_SHA" "$A2_GIT_COMMIT" <<'REMOTE'
set -euo pipefail
umask 077
REMOTE_UPLOAD=$1
EXPECTED_TAR_SHA=$2
EXPECTED_COMMIT=$3
RUN_ROOT=/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess
WORKSPACE="$RUN_ROOT/workspace-a-r2"
STAGE="$RUN_ROOT/.workspace-a-r2.stage-$EXPECTED_COMMIT"
REMOTE_ACTUAL_SOURCE_SHA=$(mktemp "$RUN_ROOT/.a2-source-actual.XXXXXX")
trap 'rm -f "$REMOTE_ACTUAL_SOURCE_SHA"' EXIT INT TERM
test ! -e "$WORKSPACE"
test ! -L "$WORKSPACE"
test ! -e "$STAGE"
test ! -L "$STAGE"
test "$(sha256sum "$REMOTE_UPLOAD" | awk '{print $1}')" = "$EXPECTED_TAR_SHA"
if tar -tf "$REMOTE_UPLOAD" | LC_ALL=C grep -Eq '(^|/)\._'; then
  echo 'uploaded A2 archive contains forbidden AppleDouble entries' >&2
  exit 1
fi
mkdir -m 700 "$STAGE"
tar -xf "$REMOTE_UPLOAD" -C "$STAGE"
test -z "$(find "$STAGE" -type f -name '._*' -print -quit)"
test "$(cat "$STAGE/SOURCE_COMMIT")" = "$EXPECTED_COMMIT"
(
  cd "$STAGE"
  sha256sum --check --strict SOURCE_SHA256SUMS
  find . -type f ! -name SOURCE_SHA256SUMS -print0 \
    | LC_ALL=C sort -z | xargs -0 sha256sum > "$REMOTE_ACTUAL_SOURCE_SHA"
  cmp SOURCE_SHA256SUMS "$REMOTE_ACTUAL_SOURCE_SHA"
)
mv -T "$STAGE" "$WORKSPACE"
rm -f "$REMOTE_UPLOAD" "$REMOTE_ACTUAL_SOURCE_SHA"
trap - EXIT INT TERM
REMOTE
)
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
WORKSPACE_SEAL_EVIDENCE="$EVIDENCE/workspace-SHA256SUMS.sha256"
ANCHOR_EVIDENCE="$EVIDENCE/a1-anchors.env"
ANCHOR_SEAL_EVIDENCE="$EVIDENCE/a1-anchors.env.sha256"

write_noclobber_stdin() {
  local pathname=$1
  (set -o noclobber; cat > "$pathname")
}

test ! -e "$ANCHORS"
for evidence_path in \
  "$WORKSPACE_SEAL_EVIDENCE" \
  "$ANCHOR_EVIDENCE" \
  "$ANCHOR_SEAL_EVIDENCE"; do
  test ! -e "$evidence_path"
  test ! -L "$evidence_path"
done

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
sha256sum "$WORKSPACE/SHA256SUMS" \
  | write_noclobber_stdin "$WORKSPACE_SEAL_EVIDENCE"
cat "$ANCHORS" | write_noclobber_stdin "$ANCHOR_EVIDENCE"
sha256sum "$ANCHOR_EVIDENCE" \
  | write_noclobber_stdin "$ANCHOR_SEAL_EVIDENCE"
sha256sum --check --strict "$WORKSPACE_SEAL_EVIDENCE"
sha256sum --check --strict "$ANCHOR_SEAL_EVIDENCE"
cmp "$ANCHORS" "$ANCHOR_EVIDENCE"
find "$WORKSPACE" -type f -exec chmod 0400 {} +
find "$WORKSPACE" -type d -exec chmod 0500 {} +
(cd "$WORKSPACE" && sha256sum --check --strict SHA256SUMS)
REMOTE
```

## 4A. Forward repair after pre-claim AppleDouble contamination

Use this forward-only branch only when Step 3 completed once, Step 4 sealed a
workspace that contains AppleDouble `._*` files, and Steps 5 onward never
started. It does not delete or rewrite the contaminated tree. It first proves
the one authority and grant are intact, proves no consumption claim or A2
runtime inode exists, and then moves the complete workspace to an evidence
directory on the same filesystem while preserving its device, inode, and
hashes.

The reviewed repair-protocol commit is separate from the runtime payload:
`SOURCE_COMMIT` remains the exact `d4360775...` tree installed in Step 2. The
local clean/upstream gate below binds the operator-reviewed runbook and test
blobs to evidence without adding them to the payload. A local-only or
upstream-divergent protocol commit is an intentional hard stop.

```zsh
REPAIR_PROTOCOL_COMMIT="<REVIEWED_A2_FORWARD_REPAIR_COMMIT>"
test "${#REPAIR_PROTOCOL_COMMIT}" -eq 40
printf '%s\n' "$REPAIR_PROTOCOL_COMMIT" | grep -Eq '^[0-9a-f]{40}$'
git -C "$REPO" cat-file -e "$REPAIR_PROTOCOL_COMMIT^{commit}"
test "$(git -C "$REPO" rev-parse HEAD)" = "$REPAIR_PROTOCOL_COMMIT"
test -z "$(git -C "$REPO" status --porcelain=v1 --untracked-files=all)"
git -C "$REPO" diff --quiet
git -C "$REPO" diff --cached --quiet
git -C "$REPO" merge-base --is-ancestor \
  d4360775194aaf8593a9fa5db10cf7465b222534 "$REPAIR_PROTOCOL_COMMIT"
REPAIR_PROTOCOL_UPSTREAM=$(git -C "$REPO" rev-parse \
  --abbrev-ref --symbolic-full-name '@{upstream}')
test "$(git -C "$REPO" rev-parse "$REPAIR_PROTOCOL_UPSTREAM^{commit}")" \
  = "$REPAIR_PROTOCOL_COMMIT"
REPAIR_RUNBOOK_BLOB=$(git -C "$REPO" rev-parse \
  "${REPAIR_PROTOCOL_COMMIT}:docs/remote-ocr-a2-deployment.md")
REPAIR_TEST_BLOB=$(git -C "$REPO" rev-parse \
  "${REPAIR_PROTOCOL_COMMIT}:tests/remote-ocr-a2-systemd.test.mjs")
printf '%s\n%s\n' "$REPAIR_RUNBOOK_BLOB" "$REPAIR_TEST_BLOB" \
  | grep -Ec '^[0-9a-f]{40}$' | grep -qx 2

"${SSH_INNER[@]}" bash -se -- \
  "$REPAIR_PROTOCOL_COMMIT" "$REPAIR_RUNBOOK_BLOB" "$REPAIR_TEST_BLOB" <<'REMOTE'
set -euo pipefail
umask 077
REPAIR_PROTOCOL_COMMIT=$1
REPAIR_RUNBOOK_BLOB=$2
REPAIR_TEST_BLOB=$3
EXPECTED_COMMIT=d4360775194aaf8593a9fa5db10cf7465b222534
RUN_ROOT=/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess
WORKSPACE="$RUN_ROOT/workspace-a-r2"
INPUT="$RUN_ROOT/input/pdfs-verified"
A1="$RUN_ROOT/output/production-p4-mb16-shard-a-r1"
A2="$RUN_ROOT/output/production-p1-mb16-shard-a-r2"
AUTHORITY="$RUN_ROOT/input/timeout-recovery-authority-v1"
MONITOR_DIR="$RUN_ROOT/monitor-a-r2"
LOCK="$RUN_ROOT/.a2-lifecycle.lock"
EVIDENCE_POINTER="$RUN_ROOT/.a2-current-evidence"

write_noclobber_stdin() {
  local pathname=$1
  (set -o noclobber; cat > "$pathname")
}

printf '%s\n%s\n%s\n' \
  "$REPAIR_PROTOCOL_COMMIT" "$REPAIR_RUNBOOK_BLOB" "$REPAIR_TEST_BLOB" \
  | grep -Ec '^[0-9a-f]{40}$' | grep -qx 3
test "$REPAIR_PROTOCOL_COMMIT" != "$EXPECTED_COMMIT"

test -f "$EVIDENCE_POINTER"
test ! -L "$EVIDENCE_POINTER"
test "$(stat -c %a "$EVIDENCE_POINTER")" = 600
test "$(stat -c %u "$EVIDENCE_POINTER")" = "$(id -u)"
EVIDENCE=$(cat "$EVIDENCE_POINTER")
case "$EVIDENCE" in
  "$RUN_ROOT"/a2-deploy-evidence/*) ;;
  *) echo 'A2 evidence pointer escaped the run root' >&2; exit 1 ;;
esac
test -d "$EVIDENCE"
test ! -L "$EVIDENCE"
test "$(realpath -e "$EVIDENCE")" = "$EVIDENCE"
test "$(stat -c %a "$EVIDENCE")" = 700
test "$(stat -c %u "$EVIDENCE")" = "$(id -u)"

INCIDENT_PARENT="$EVIDENCE/incidents"
INCIDENT="$INCIDENT_PARENT/appledouble-preclaim-d4360775"
QUARANTINED_WORKSPACE="$INCIDENT/workspace-a-r2-contaminated"
test ! -e "$INCIDENT"
test ! -L "$INCIDENT"
if test -e "$INCIDENT_PARENT" || test -L "$INCIDENT_PARENT"; then
  test -d "$INCIDENT_PARENT"
  test ! -L "$INCIDENT_PARENT"
  test "$(stat -c %a "$INCIDENT_PARENT")" = 700
  test "$(stat -c %u "$INCIDENT_PARENT")" = "$(id -u)"
else
  mkdir -m 700 "$INCIDENT_PARENT"
fi

test -d "$AUTHORITY"
test ! -L "$AUTHORITY"
test "$(realpath -e "$AUTHORITY")" = "$AUTHORITY"
test "$(stat -c %a "$AUTHORITY")" = 700
test "$(stat -c %u "$AUTHORITY")" = "$(id -u)"
test -f "$AUTHORITY/ledger-identity.json"
test ! -L "$AUTHORITY/ledger-identity.json"
test -f "$AUTHORITY/ledger-identity.json.sha256"
test ! -L "$AUTHORITY/ledger-identity.json.sha256"
(cd "$AUTHORITY" && sha256sum --check --strict ledger-identity.json.sha256)

GRANT="$A1/timeout-recovery-grant.json"
test -f "$GRANT"
test ! -L "$GRANT"
test -f "$GRANT.sha256"
test ! -L "$GRANT.sha256"
(cd "$A1" && sha256sum --check --strict timeout-recovery-grant.json.sha256)
test "$(jq -r '.consumption.ledger_root' "$GRANT")" = "$AUTHORITY"
test "$(jq -r '.consumption.ledger_device' "$GRANT")" = "$(stat -c %d "$AUTHORITY")"
test "$(jq -r '.consumption.ledger_inode' "$GRANT")" = "$(stat -c %i "$AUTHORITY")"

shopt -s nullglob
ISSUANCE_FILES=("$AUTHORITY"/*.issuance.json)
ISSUANCE_SEALS=("$AUTHORITY"/*.issuance.json.sha256)
CLAIM_FILES=("$AUTHORITY"/*.claim.json)
CLAIM_SEALS=("$AUTHORITY"/*.claim.json.sha256)
test "${#ISSUANCE_FILES[@]}" -eq 1
test "${#ISSUANCE_SEALS[@]}" -eq 1
test "${ISSUANCE_FILES[0]}.sha256" = "${ISSUANCE_SEALS[0]}"
(cd "$AUTHORITY" && sha256sum --check --strict "$(basename "${ISSUANCE_SEALS[0]}")")
AUTHORITY_CLAIM_COUNT=${#CLAIM_FILES[@]}
test "$AUTHORITY_CLAIM_COUNT" -eq 0
test "${#CLAIM_SEALS[@]}" -eq 0
test ! -e "$A2"
test ! -L "$A2"
test ! -e "$MONITOR_DIR"
test ! -L "$MONITOR_DIR"
test ! -e "$LOCK"
test ! -L "$LOCK"
A2_RUNTIME_PATHS=(
  "$HOME/.config/systemd/user/curriculum-ocr-reprocess-a-r2.service"
  "$HOME/.config/systemd/user/curriculum-ocr-reprocess-a-r2-cleanup.service"
  "$HOME/.config/systemd/user/curriculum-ocr-reprocess-a-r2-monitor.service"
  "$HOME/.config/systemd/user/curriculum-ocr-reprocess-a-r2-monitor.timer"
  "$HOME/.config/systemd/user/curriculum-ocr-reprocess-a-r2-monitor.service.d/alert-only.conf"
  "$HOME/.config/bdfz/curriculum-ocr-reprocess-a-r2-cleanup.conf"
)
for runtime_path in "${A2_RUNTIME_PATHS[@]}"; do
  test ! -e "$runtime_path"
  test ! -L "$runtime_path"
done

test -f "$EVIDENCE/a1-pregrant.SHA256SUMS"
test -f "$EVIDENCE/a1-pregrant.SHA256SUMS.sha256"
sha256sum --check --strict "$EVIDENCE/a1-pregrant.SHA256SUMS.sha256"
(cd "$A1" && sha256sum --check --strict "$EVIDENCE/a1-pregrant.SHA256SUMS")
test -f "$EVIDENCE/authority-grant-evidence.SHA256SUMS"
sha256sum --check --strict "$EVIDENCE/authority-grant-evidence.SHA256SUMS"
test -f "$EVIDENCE/workspace-SHA256SUMS.sha256"
test -f "$EVIDENCE/a1-anchors.env"
test -f "$EVIDENCE/a1-anchors.env.sha256"
sha256sum --check --strict "$EVIDENCE/workspace-SHA256SUMS.sha256"
sha256sum --check --strict "$EVIDENCE/a1-anchors.env.sha256"

test -d "$WORKSPACE"
test ! -L "$WORKSPACE"
test "$(realpath -e "$WORKSPACE")" = "$WORKSPACE"
test "$(cat "$WORKSPACE/SOURCE_COMMIT")" = "$EXPECTED_COMMIT"
(cd "$WORKSPACE" && sha256sum --check --strict SOURCE_SHA256SUMS)
(cd "$WORKSPACE" && sha256sum --check --strict SHA256SUMS)
APPLEDOUBLE_COUNT=$(find "$WORKSPACE" -type f -name '._*' -printf . | wc -c)
test "$APPLEDOUBLE_COUNT" -gt 0

mkdir -m 700 "$INCIDENT"
test "$(stat -c %d "$INCIDENT")" = "$(stat -c %d "$WORKSPACE")"
printf 'schema_version=1\nstate=preclaim_appledouble_quarantine\nsource_commit=%s\nappledouble_count=%s\ncitation_allowed=false\n' \
  "$EXPECTED_COMMIT" "$APPLEDOUBLE_COUNT" \
  | write_noclobber_stdin "$INCIDENT/incident.env"
printf 'repair_protocol_commit=%s\nrunbook_blob=%s\ntest_blob=%s\n' \
  "$REPAIR_PROTOCOL_COMMIT" "$REPAIR_RUNBOOK_BLOB" "$REPAIR_TEST_BLOB" \
  | write_noclobber_stdin "$INCIDENT/repair-protocol.env"
(cd "$WORKSPACE" && find . -type f -name '._*' -print0 \
  | LC_ALL=C sort -z | tr '\0' '\n') \
  | write_noclobber_stdin "$INCIDENT/appledouble-files.txt"
(cd "$WORKSPACE" && find . -type f -name '._*' -print0 \
  | LC_ALL=C sort -z | xargs -0 -r sha256sum) \
  | write_noclobber_stdin "$INCIDENT/appledouble-files.SHA256SUMS"
sha256sum "$WORKSPACE/SOURCE_COMMIT" "$WORKSPACE/SOURCE_SHA256SUMS" \
  "$WORKSPACE/a1-anchors.env" "$WORKSPACE/SHA256SUMS" \
  | write_noclobber_stdin "$INCIDENT/contaminated-workspace-seals.sha256"
stat -c 'device=%d\ninode=%i\nmode=%a\nuid=%u\ngid=%g' "$WORKSPACE" \
  | write_noclobber_stdin "$INCIDENT/workspace-stat-before.env"

WORKSPACE_DEVICE_BEFORE=$(stat -c %d "$WORKSPACE")
WORKSPACE_INODE_BEFORE=$(stat -c %i "$WORKSPACE")
mv -T "$WORKSPACE" "$QUARANTINED_WORKSPACE"
test ! -e "$WORKSPACE"
test ! -L "$WORKSPACE"
test -d "$QUARANTINED_WORKSPACE"
test ! -L "$QUARANTINED_WORKSPACE"
WORKSPACE_DEVICE_AFTER=$(stat -c %d "$QUARANTINED_WORKSPACE")
WORKSPACE_INODE_AFTER=$(stat -c %i "$QUARANTINED_WORKSPACE")
test "$WORKSPACE_DEVICE_BEFORE" = "$WORKSPACE_DEVICE_AFTER"
test "$WORKSPACE_INODE_BEFORE" = "$WORKSPACE_INODE_AFTER"
test "$(cat "$QUARANTINED_WORKSPACE/SOURCE_COMMIT")" = "$EXPECTED_COMMIT"
(cd "$QUARANTINED_WORKSPACE" && sha256sum --check --strict SOURCE_SHA256SUMS)
(cd "$QUARANTINED_WORKSPACE" && sha256sum --check --strict SHA256SUMS)
stat -c 'device=%d\ninode=%i\nmode=%a\nuid=%u\ngid=%g' "$QUARANTINED_WORKSPACE" \
  | write_noclobber_stdin "$INCIDENT/workspace-stat-after.env"
(
  cd "$INCIDENT"
  find . -type f ! -name QUARANTINE_EVIDENCE_SHA256SUMS -print0 \
    | LC_ALL=C sort -z | xargs -0 sha256sum
) | write_noclobber_stdin "$INCIDENT/QUARANTINE_EVIDENCE_SHA256SUMS"
(cd "$INCIDENT" && sha256sum --check --strict QUARANTINE_EVIDENCE_SHA256SUMS)
REMOTE
```

After the quarantine command succeeds, set local `A2_GIT_COMMIT` to exactly
`d4360775194aaf8593a9fa5db10cf7465b222534` and rerun **only Step 2 once**.
Do not rerun Step 1, Step 3, or any authority/grant write. Then run the
following read-only revalidation and evidence-sealing command before Step 5.

```zsh
REPAIR_PROTOCOL_COMMIT="<REVIEWED_A2_FORWARD_REPAIR_COMMIT>"
test "${#REPAIR_PROTOCOL_COMMIT}" -eq 40
test "$(git -C "$REPO" rev-parse HEAD)" = "$REPAIR_PROTOCOL_COMMIT"
test -z "$(git -C "$REPO" status --porcelain=v1 --untracked-files=all)"
git -C "$REPO" diff --quiet
git -C "$REPO" diff --cached --quiet
git -C "$REPO" merge-base --is-ancestor \
  d4360775194aaf8593a9fa5db10cf7465b222534 "$REPAIR_PROTOCOL_COMMIT"
REPAIR_PROTOCOL_UPSTREAM=$(git -C "$REPO" rev-parse \
  --abbrev-ref --symbolic-full-name '@{upstream}')
test "$(git -C "$REPO" rev-parse "$REPAIR_PROTOCOL_UPSTREAM^{commit}")" \
  = "$REPAIR_PROTOCOL_COMMIT"
REPAIR_RUNBOOK_BLOB=$(git -C "$REPO" rev-parse \
  "${REPAIR_PROTOCOL_COMMIT}:docs/remote-ocr-a2-deployment.md")
REPAIR_TEST_BLOB=$(git -C "$REPO" rev-parse \
  "${REPAIR_PROTOCOL_COMMIT}:tests/remote-ocr-a2-systemd.test.mjs")

"${SSH_INNER[@]}" bash -se -- \
  "$REPAIR_PROTOCOL_COMMIT" "$REPAIR_RUNBOOK_BLOB" "$REPAIR_TEST_BLOB" <<'REMOTE'
set -euo pipefail
umask 077
REPAIR_PROTOCOL_COMMIT=$1
REPAIR_RUNBOOK_BLOB=$2
REPAIR_TEST_BLOB=$3
EXPECTED_COMMIT=d4360775194aaf8593a9fa5db10cf7465b222534
RUN_ROOT=/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess
WORKSPACE="$RUN_ROOT/workspace-a-r2"
INPUT="$RUN_ROOT/input/pdfs-verified"
MANIFEST="$RUN_ROOT/manifests/offload-shard-a.json"
A1="$RUN_ROOT/output/production-p4-mb16-shard-a-r1"
A2="$RUN_ROOT/output/production-p1-mb16-shard-a-r2"
AUTHORITY="$RUN_ROOT/input/timeout-recovery-authority-v1"
MONITOR_DIR="$RUN_ROOT/monitor-a-r2"
LOCK="$RUN_ROOT/.a2-lifecycle.lock"
EVIDENCE=$(cat "$RUN_ROOT/.a2-current-evidence")
INCIDENT="$EVIDENCE/incidents/appledouble-preclaim-d4360775"
QUARANTINED_WORKSPACE="$INCIDENT/workspace-a-r2-contaminated"
ANCHORS="$WORKSPACE/a1-anchors.env"
SOURCE_ACTUAL=$(mktemp "$RUN_ROOT/.a2-forward-source-actual.XXXXXX")
FINAL_ACTUAL=$(mktemp "$RUN_ROOT/.a2-forward-final-actual.XXXXXX")
trap 'rm -f "$SOURCE_ACTUAL" "$FINAL_ACTUAL"' EXIT INT TERM

write_noclobber_stdin() {
  local pathname=$1
  (set -o noclobber; cat > "$pathname")
}

test -d "$EVIDENCE"
test ! -L "$EVIDENCE"
test "$(realpath -e "$EVIDENCE")" = "$EVIDENCE"
test "$(stat -c %a "$EVIDENCE")" = 700
test "$(stat -c %u "$EVIDENCE")" = "$(id -u)"
test -d "$INCIDENT"
test ! -L "$INCIDENT"
test -d "$QUARANTINED_WORKSPACE"
test ! -L "$QUARANTINED_WORKSPACE"
(cd "$INCIDENT" && sha256sum --check --strict QUARANTINE_EVIDENCE_SHA256SUMS)
test "$(sed -n 's/^repair_protocol_commit=//p' \
  "$INCIDENT/repair-protocol.env")" = "$REPAIR_PROTOCOL_COMMIT"
test "$(sed -n 's/^runbook_blob=//p' \
  "$INCIDENT/repair-protocol.env")" = "$REPAIR_RUNBOOK_BLOB"
test "$(sed -n 's/^test_blob=//p' \
  "$INCIDENT/repair-protocol.env")" = "$REPAIR_TEST_BLOB"

test -d "$AUTHORITY"
test ! -L "$AUTHORITY"
test "$(realpath -e "$AUTHORITY")" = "$AUTHORITY"
test "$(stat -c %a "$AUTHORITY")" = 700
test "$(stat -c %u "$AUTHORITY")" = "$(id -u)"
(cd "$AUTHORITY" && sha256sum --check --strict ledger-identity.json.sha256)
GRANT="$A1/timeout-recovery-grant.json"
(cd "$A1" && sha256sum --check --strict timeout-recovery-grant.json.sha256)
test "$(jq -r '.consumption.ledger_root' "$GRANT")" = "$AUTHORITY"
test "$(jq -r '.consumption.ledger_device' "$GRANT")" = "$(stat -c %d "$AUTHORITY")"
test "$(jq -r '.consumption.ledger_inode' "$GRANT")" = "$(stat -c %i "$AUTHORITY")"
shopt -s nullglob
ISSUANCE_FILES=("$AUTHORITY"/*.issuance.json)
ISSUANCE_SEALS=("$AUTHORITY"/*.issuance.json.sha256)
CLAIM_FILES=("$AUTHORITY"/*.claim.json)
CLAIM_SEALS=("$AUTHORITY"/*.claim.json.sha256)
test "${#ISSUANCE_FILES[@]}" -eq 1
test "${#ISSUANCE_SEALS[@]}" -eq 1
(cd "$AUTHORITY" && sha256sum --check --strict "$(basename "${ISSUANCE_SEALS[0]}")")
AUTHORITY_CLAIM_COUNT=${#CLAIM_FILES[@]}
test "$AUTHORITY_CLAIM_COUNT" -eq 0
test "${#CLAIM_SEALS[@]}" -eq 0
test ! -e "$A2"
test ! -L "$A2"
test ! -e "$MONITOR_DIR"
test ! -L "$MONITOR_DIR"
test ! -e "$LOCK"
test ! -L "$LOCK"
A2_RUNTIME_PATHS=(
  "$HOME/.config/systemd/user/curriculum-ocr-reprocess-a-r2.service"
  "$HOME/.config/systemd/user/curriculum-ocr-reprocess-a-r2-cleanup.service"
  "$HOME/.config/systemd/user/curriculum-ocr-reprocess-a-r2-monitor.service"
  "$HOME/.config/systemd/user/curriculum-ocr-reprocess-a-r2-monitor.timer"
  "$HOME/.config/systemd/user/curriculum-ocr-reprocess-a-r2-monitor.service.d/alert-only.conf"
  "$HOME/.config/bdfz/curriculum-ocr-reprocess-a-r2-cleanup.conf"
)
for runtime_path in "${A2_RUNTIME_PATHS[@]}"; do
  test ! -e "$runtime_path"
  test ! -L "$runtime_path"
done
(cd "$A1" && sha256sum --check --strict "$EVIDENCE/a1-pregrant.SHA256SUMS")
sha256sum --check --strict "$EVIDENCE/authority-grant-evidence.SHA256SUMS"

test -d "$WORKSPACE"
test ! -L "$WORKSPACE"
test "$(realpath -e "$WORKSPACE")" = "$WORKSPACE"
test "$(cat "$WORKSPACE/SOURCE_COMMIT")" = "$EXPECTED_COMMIT"
test -z "$(find "$WORKSPACE" -type f -name '._*' -print -quit)"
(
  cd "$WORKSPACE"
  sha256sum --check --strict SOURCE_SHA256SUMS
  find . -type f ! -name SOURCE_SHA256SUMS -print0 \
    | LC_ALL=C sort -z | xargs -0 sha256sum > "$SOURCE_ACTUAL"
  cmp SOURCE_SHA256SUMS "$SOURCE_ACTUAL"
)
cmp "$QUARANTINED_WORKSPACE/SOURCE_SHA256SUMS" "$WORKSPACE/SOURCE_SHA256SUMS"

node "$WORKSPACE/scripts/provision-timeout-recovery-authority.mjs" \
  --input-root "$INPUT" \
  | write_noclobber_stdin "$INCIDENT/authority-repair-preview-1.json"
node "$WORKSPACE/scripts/provision-timeout-recovery-authority.mjs" \
  --input-root "$INPUT" \
  | write_noclobber_stdin "$INCIDENT/authority-repair-preview-2.json"
cmp "$INCIDENT/authority-repair-preview-1.json" \
  "$INCIDENT/authority-repair-preview-2.json"
jq -e '.status == "verified_idempotent" and (.planned_writes | length == 0)' \
  "$INCIDENT/authority-repair-preview-1.json" >/dev/null

node "$WORKSPACE/scripts/prepare-timeout-recovery-grant.mjs" \
  --manifest "$MANIFEST" --predecessor-root "$A1" \
  --ledger-root "$AUTHORITY" \
  | write_noclobber_stdin "$INCIDENT/grant-repair-preview-1.json"
node "$WORKSPACE/scripts/prepare-timeout-recovery-grant.mjs" \
  --manifest "$MANIFEST" --predecessor-root "$A1" \
  --ledger-root "$AUTHORITY" \
  | write_noclobber_stdin "$INCIDENT/grant-repair-preview-2.json"
cmp "$INCIDENT/grant-repair-preview-1.json" \
  "$INCIDENT/grant-repair-preview-2.json"
for preview in \
  "$INCIDENT/grant-repair-preview-1.json" \
  "$INCIDENT/grant-repair-preview-2.json"; do
  jq -e '.status == "verified_idempotent" and (.planned_writes | length == 0)' \
    "$preview" >/dev/null
done

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
sha256sum --check --strict "$EVIDENCE/a1-anchors.env.sha256"
cmp "$EVIDENCE/a1-anchors.env" "$ANCHORS"

(
  cd "$WORKSPACE"
  find . -type f ! -name SHA256SUMS -print0 \
    | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS
  sha256sum --check --strict SHA256SUMS
  find . -type f ! -name SHA256SUMS -print0 \
    | LC_ALL=C sort -z | xargs -0 sha256sum > "$FINAL_ACTUAL"
  cmp SHA256SUMS "$FINAL_ACTUAL"
)
test -z "$(find "$WORKSPACE" -type f -name '._*' -print -quit)"
sha256sum "$WORKSPACE/SOURCE_COMMIT" "$WORKSPACE/SOURCE_SHA256SUMS" \
  "$WORKSPACE/a1-anchors.env" "$WORKSPACE/SHA256SUMS" \
  | write_noclobber_stdin "$INCIDENT/clean-workspace-seals.sha256"
stat -c 'device=%d\ninode=%i\nmode=%a\nuid=%u\ngid=%g' "$WORKSPACE" \
  | write_noclobber_stdin "$INCIDENT/clean-workspace-stat.env"

test ! -e "$A2"
test ! -e "$MONITOR_DIR"
test ! -e "$LOCK"
AUTHORITY_CLAIM_COUNT=$(find "$AUTHORITY" -maxdepth 1 -type f -name '*.claim.json' -printf . | wc -c)
test "$AUTHORITY_CLAIM_COUNT" -eq 0
(
  cd "$INCIDENT"
  find . -type f ! -name FORWARD_REPAIR_SHA256SUMS -print0 \
    | LC_ALL=C sort -z | xargs -0 sha256sum
) | write_noclobber_stdin "$INCIDENT/FORWARD_REPAIR_SHA256SUMS"
(cd "$INCIDENT" && sha256sum --check --strict FORWARD_REPAIR_SHA256SUMS)
find "$WORKSPACE" -type f -exec chmod 0400 {} +
find "$WORKSPACE" -type d -exec chmod 0500 {} +
find "$INCIDENT" -type f -exec chmod 0400 {} +
find "$INCIDENT" -type d -exec chmod 0500 {} +
(cd "$WORKSPACE" && sha256sum --check --strict SHA256SUMS)
trap - EXIT INT TERM
rm -f "$SOURCE_ACTUAL" "$FINAL_ACTUAL"
REMOTE
```

The clean workspace final seal is expected to differ from the quarantined
workspace final seal because the unlisted AppleDouble files are gone. The
reviewed source manifest and all five A1 anchor bytes must remain identical.
Any failed gate freezes both trees for review; it never authorizes another
grant, authority, or destructive in-place cleanup.

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
`LoadState=not-found` is tolerated only when `file-state.tsv` proves that the
corresponding unit file was absent before deployment and it is still absent as
both a path and symlink. Every other missing, failed stop, masked state, or
ambiguous manager response is a hard stop. No shared file is restored and no
`daemon-reload` occurs until the complete A2 chain is proven quiescent.

```bash
set -euo pipefail
RUN_ROOT=/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess
BACKUP=$(cat "$RUN_ROOT/.a2-current-backup")
EVIDENCE=$(cat "$RUN_ROOT/.a2-current-evidence")
ALERT_RUNTIME="$HOME/curriculum-ocr-offload/alert-runtime"
QUIESCENCE_VERIFIED=0

reviewed_unit_absent() {
  local unit=$1
  local relative=$2
  test "$(systemctl --user show "$unit" --property=LoadState --value)" = not-found
  grep -Fqx "$(printf 'absent\t%s' "$relative")" "$BACKUP/file-state.tsv"
  test ! -e "$HOME/$relative"
  test ! -L "$HOME/$relative"
}

assert_timer_inactive() {
  local unit=$1
  local ACTIVE_STATE
  ACTIVE_STATE=$(systemctl --user show "$unit" --property=ActiveState --value)
  test "$ACTIVE_STATE" = inactive
}

assert_process_unit_inactive() {
  local unit=$1
  local ACTIVE_STATE MAIN_PID
  ACTIVE_STATE=$(systemctl --user show "$unit" --property=ActiveState --value)
  MAIN_PID=$(systemctl --user show "$unit" --property=MainPID --value)
  test "$ACTIVE_STATE" = inactive
  test "$MAIN_PID" = 0
}

assert_disabled() {
  local unit=$1
  local ENABLED_STATE ENABLED_RC
  if ENABLED_STATE=$(systemctl --user is-enabled "$unit" 2>/dev/null); then
    ENABLED_RC=0
  else
    ENABLED_RC=$?
  fi
  test "$ENABLED_RC" -ne 0
  test "$ENABLED_STATE" = disabled
}

disable_timer_or_reviewed_absent() {
  local unit=$1
  local relative=$2
  local LOAD_STATE
  LOAD_STATE=$(systemctl --user show "$unit" --property=LoadState --value)
  case "$LOAD_STATE" in
    loaded)
      systemctl --user disable --now "$unit"
      assert_timer_inactive "$unit"
      assert_disabled "$unit"
      ;;
    not-found)
      reviewed_unit_absent "$unit" "$relative"
      ;;
    *) echo "unsafe timer LoadState for $unit: $LOAD_STATE" >&2; return 1 ;;
  esac
}

disable_worker_or_reviewed_absent() {
  local unit=$1
  local relative=$2
  local LOAD_STATE
  LOAD_STATE=$(systemctl --user show "$unit" --property=LoadState --value)
  case "$LOAD_STATE" in
    loaded)
      systemctl --user disable --now "$unit"
      assert_process_unit_inactive "$unit"
      assert_disabled "$unit"
      ;;
    not-found)
      reviewed_unit_absent "$unit" "$relative"
      ;;
    *) echo "unsafe worker LoadState for $unit: $LOAD_STATE" >&2; return 1 ;;
  esac
}

stop_service_or_reviewed_absent() {
  local unit=$1
  local relative=$2
  local LOAD_STATE
  LOAD_STATE=$(systemctl --user show "$unit" --property=LoadState --value)
  case "$LOAD_STATE" in
    loaded)
      systemctl --user stop "$unit"
      assert_process_unit_inactive "$unit"
      ;;
    not-found)
      reviewed_unit_absent "$unit" "$relative"
      ;;
    *) echo "unsafe service LoadState for $unit: $LOAD_STATE" >&2; return 1 ;;
  esac
}

assert_timer_quiet_or_reviewed_absent() {
  local unit=$1
  local relative=$2
  local LOAD_STATE
  LOAD_STATE=$(systemctl --user show "$unit" --property=LoadState --value)
  case "$LOAD_STATE" in
    loaded) assert_timer_inactive "$unit"; assert_disabled "$unit" ;;
    not-found) reviewed_unit_absent "$unit" "$relative" ;;
    *) echo "unsafe timer LoadState for $unit: $LOAD_STATE" >&2; return 1 ;;
  esac
}

assert_worker_quiet_or_reviewed_absent() {
  local unit=$1
  local relative=$2
  local LOAD_STATE
  LOAD_STATE=$(systemctl --user show "$unit" --property=LoadState --value)
  case "$LOAD_STATE" in
    loaded) assert_process_unit_inactive "$unit"; assert_disabled "$unit" ;;
    not-found) reviewed_unit_absent "$unit" "$relative" ;;
    *) echo "unsafe worker LoadState for $unit: $LOAD_STATE" >&2; return 1 ;;
  esac
}

assert_service_quiet_or_reviewed_absent() {
  local unit=$1
  local relative=$2
  local LOAD_STATE
  LOAD_STATE=$(systemctl --user show "$unit" --property=LoadState --value)
  case "$LOAD_STATE" in
    loaded) assert_process_unit_inactive "$unit" ;;
    not-found) reviewed_unit_absent "$unit" "$relative" ;;
    *) echo "unsafe service LoadState for $unit: $LOAD_STATE" >&2; return 1 ;;
  esac
}

MONITOR_TIMER=curriculum-ocr-reprocess-a-r2-monitor.timer
ALERT_RETRY_TIMER=curriculum-ocr-monitor-alert-retry@curriculum-ocr-reprocess-a-r2-monitor.service.timer
WORKER=curriculum-ocr-reprocess-a-r2.service
MONITOR=curriculum-ocr-reprocess-a-r2-monitor.service
ALERT_HANDLER=curriculum-ocr-monitor-alert@curriculum-ocr-reprocess-a-r2-monitor.service.service
CLEANUP=curriculum-ocr-reprocess-a-r2-cleanup.service
LLAMA=curriculum-ocr-llama.service

disable_timer_or_reviewed_absent "$MONITOR_TIMER" \
  .config/systemd/user/curriculum-ocr-reprocess-a-r2-monitor.timer
disable_timer_or_reviewed_absent "$ALERT_RETRY_TIMER" \
  .config/systemd/user/curriculum-ocr-monitor-alert-retry@.timer
disable_worker_or_reviewed_absent "$WORKER" \
  .config/systemd/user/curriculum-ocr-reprocess-a-r2.service
stop_service_or_reviewed_absent "$MONITOR" \
  .config/systemd/user/curriculum-ocr-reprocess-a-r2-monitor.service
stop_service_or_reviewed_absent "$ALERT_HANDLER" \
  .config/systemd/user/curriculum-ocr-monitor-alert@.service
stop_service_or_reviewed_absent "$CLEANUP" \
  .config/systemd/user/curriculum-ocr-reprocess-a-r2-cleanup.service
stop_service_or_reviewed_absent "$LLAMA" \
  .config/systemd/user/curriculum-ocr-llama.service

# Re-prove every state after all stop operations. In particular, cleanup must
# be inactive after the worker reaches its final inactive state.
assert_timer_quiet_or_reviewed_absent "$MONITOR_TIMER" \
  .config/systemd/user/curriculum-ocr-reprocess-a-r2-monitor.timer
assert_timer_quiet_or_reviewed_absent "$ALERT_RETRY_TIMER" \
  .config/systemd/user/curriculum-ocr-monitor-alert-retry@.timer
assert_worker_quiet_or_reviewed_absent "$WORKER" \
  .config/systemd/user/curriculum-ocr-reprocess-a-r2.service
assert_service_quiet_or_reviewed_absent "$MONITOR" \
  .config/systemd/user/curriculum-ocr-reprocess-a-r2-monitor.service
assert_service_quiet_or_reviewed_absent "$ALERT_HANDLER" \
  .config/systemd/user/curriculum-ocr-monitor-alert@.service
assert_service_quiet_or_reviewed_absent "$CLEANUP" \
  .config/systemd/user/curriculum-ocr-reprocess-a-r2-cleanup.service
assert_service_quiet_or_reviewed_absent "$LLAMA" \
  .config/systemd/user/curriculum-ocr-llama.service

systemctl --user show "$MONITOR_TIMER" "$ALERT_RETRY_TIMER" "$WORKER" \
  "$MONITOR" "$ALERT_HANDLER" "$CLEANUP" "$LLAMA" \
  --property=Id --property=LoadState --property=UnitFileState \
  --property=ActiveState --property=SubState --property=MainPID --no-pager \
  > "$EVIDENCE/a2-rollback-quiescence.txt"
QUIESCENCE_VERIFIED=1
test "$QUIESCENCE_VERIFIED" = 1

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
