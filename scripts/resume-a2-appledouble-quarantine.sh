#!/usr/bin/env bash
set -euo pipefail
umask 077

die() {
  printf 'A2 partial-resume rejected: %s\n' "$*" >&2
  if test "${BDFZ_A2_RESUME_LIBRARY_ONLY:-0}" = 1; then
    return 1
  fi
  exit 1
}

stat_value() {
  local format=$1
  local pathname=$2
  if stat -c "$format" "$pathname" >/dev/null 2>&1; then
    stat -c "$format" "$pathname"
    return
  fi
  case "$format" in
    %a) stat -f %Lp "$pathname" ;;
    %d) stat -f %d "$pathname" ;;
    %g) stat -f %g "$pathname" ;;
    %h) stat -f %l "$pathname" ;;
    %i) stat -f %i "$pathname" ;;
    %s) stat -f %z "$pathname" ;;
    %u) stat -f %u "$pathname" ;;
    *) die "unsupported stat format: $format" ;;
  esac
}

sha256_value() {
  sha256sum "$1" | awk '{print $1}'
}

assert_exact_regular_file() {
  local pathname=$1
  local expected_mode=$2
  local expected_uid=$3
  local expected_nlink=$4
  local expected_size=$5
  local expected_sha256=$6
  test -f "$pathname" || die "missing regular file: $pathname"
  test ! -L "$pathname" || die "symlink rejected: $pathname"
  test "$(stat_value %a "$pathname")" = "$expected_mode" || die "mode drift: $pathname"
  test "$(stat_value %u "$pathname")" = "$expected_uid" || die "owner drift: $pathname"
  test "$(stat_value %h "$pathname")" = "$expected_nlink" || die "link-count drift: $pathname"
  test "$(stat_value %s "$pathname")" = "$expected_size" || die "size drift: $pathname"
  test "$(sha256_value "$pathname")" = "$expected_sha256" || die "hash drift: $pathname"
}

assert_exact_incident_top_level() {
  local incident=$1
  local state=${2:-PREMOVE_READY}
  local -a expected=(
    appledouble-files.SHA256SUMS
    appledouble-files.txt
    contaminated-workspace-seals.sha256
    incident.env
    repair-protocol.env
    workspace-stat-before.env
  )
  case "$state" in
    PREMOVE_READY) ;;
    MOVED_UNSEALED)
      expected+=(workspace-a-r2-contaminated)
      local marker
      for marker in \
        resume-protocol.env \
        workspace-stat-after.env \
        QUARANTINE_EVIDENCE_SHA256SUMS \
        QUARANTINE_EVIDENCE_SHA256SUMS.sha256; do
        if test -e "$incident/$marker" || test -L "$incident/$marker"; then
          expected+=("$marker")
        fi
      done
      ;;
    SEALED)
      expected+=(
        QUARANTINE_EVIDENCE_SHA256SUMS
        QUARANTINE_EVIDENCE_SHA256SUMS.sha256
        resume-protocol.env
        workspace-a-r2-contaminated
        workspace-stat-after.env
      )
      ;;
    *) die "unknown incident state: $state"; return 1 ;;
  esac

  shopt -s dotglob nullglob
  local -a actual=("$incident"/*)
  test "${#actual[@]}" -eq "${#expected[@]}" || die "unexpected incident entry count"
  local pathname name found expected_name
  for pathname in "${actual[@]}"; do
    name=${pathname##*/}
    found=0
    for expected_name in "${expected[@]}"; do
      if test "$name" = "$expected_name"; then
        found=1
        break
      fi
    done
    test "$found" -eq 1 || die "unexpected incident entry: $name"
    if test "$name" = workspace-a-r2-contaminated; then
      test -d "$pathname" && test ! -L "$pathname" || die "quarantine workspace type drift"
    else
      test -f "$pathname" && test ! -L "$pathname" || die "incident file type drift: $name"
    fi
  done
}

classify_state() {
  local workspace=$1
  local quarantined_workspace=$2
  local expected_device=$3
  local expected_inode=$4
  local incident=${5:-${quarantined_workspace%/*}}
  local workspace_present=0
  local quarantined_present=0
  if test -e "$workspace" || test -L "$workspace"; then workspace_present=1; fi
  if test -e "$quarantined_workspace" || test -L "$quarantined_workspace"; then quarantined_present=1; fi
  test "$((workspace_present + quarantined_present))" -eq 1 \
    || die "workspace paths are ambiguous"

  local active
  if test "$workspace_present" -eq 1; then
    active=$workspace
  else
    active=$quarantined_workspace
  fi
  test -d "$active" && test ! -L "$active" || die "active workspace is not a real directory"
  test "$(stat_value %d "$active")" = "$expected_device" || die "workspace device drift"
  test "$(stat_value %i "$active")" = "$expected_inode" || die "workspace inode drift"

  local marker_count=0
  local marker
  for marker in \
    resume-protocol.env \
    workspace-stat-after.env \
    QUARANTINE_EVIDENCE_SHA256SUMS \
    QUARANTINE_EVIDENCE_SHA256SUMS.sha256; do
    if test -e "$incident/$marker" || test -L "$incident/$marker"; then
      marker_count=$((marker_count + 1))
    fi
  done
  case "$workspace_present:$marker_count" in
    1:0) printf '%s\n' PREMOVE_READY ;;
    0:0|0:1|0:2|0:3) printf '%s\n' MOVED_UNSEALED ;;
    0:4) printf '%s\n' SEALED ;;
    *) die "partial or misplaced sealing evidence" ;;
  esac
}

atomic_noclobber_bytes() {
  local pathname=$1
  local payload=$2
  local expected_device=$3
  local expected_parent_inode=$4
  local expected_uid=$5
  local expected_gid=$6
  local expected_mode=$7
  local expected_parent_nlink=$8
  local fail_after_fsync=${9:-0}
  BDFZ_A2_ATOMIC_PAYLOAD=$payload \
  BDFZ_A2_ATOMIC_DEVICE=$expected_device \
  BDFZ_A2_ATOMIC_PARENT_INODE=$expected_parent_inode \
  BDFZ_A2_ATOMIC_UID=$expected_uid \
  BDFZ_A2_ATOMIC_GID=$expected_gid \
  BDFZ_A2_ATOMIC_MODE=$expected_mode \
  BDFZ_A2_ATOMIC_PARENT_NLINK=$expected_parent_nlink \
  BDFZ_A2_ATOMIC_FAIL_AFTER_FSYNC=$fail_after_fsync \
  /usr/bin/python3 -c '
import ctypes
import os
import stat
import sys

target = os.fsencode(sys.argv[1])
parent, name = os.path.split(target)
if not parent:
    parent = b"."
if not name or b"/" in name:
    raise SystemExit("invalid target basename")
if not hasattr(os, "O_TMPFILE"):
    raise SystemExit("O_TMPFILE unavailable")

payload = os.environb.pop(b"BDFZ_A2_ATOMIC_PAYLOAD")
expected_device = int(os.environ.pop("BDFZ_A2_ATOMIC_DEVICE"))
expected_parent_inode = int(os.environ.pop("BDFZ_A2_ATOMIC_PARENT_INODE"))
expected_uid = int(os.environ.pop("BDFZ_A2_ATOMIC_UID"))
expected_gid = int(os.environ.pop("BDFZ_A2_ATOMIC_GID"))
expected_mode = int(os.environ.pop("BDFZ_A2_ATOMIC_MODE"), 8)
expected_parent_nlink = int(os.environ.pop("BDFZ_A2_ATOMIC_PARENT_NLINK"))
fail_after_fsync = os.environ.pop("BDFZ_A2_ATOMIC_FAIL_AFTER_FSYNC") == "1"

dirfd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
fd = -1
try:
    parent_stat = os.fstat(dirfd)
    if not stat.S_ISDIR(parent_stat.st_mode):
        raise OSError("target parent is not a directory")
    if (
        parent_stat.st_dev != expected_device
        or parent_stat.st_ino != expected_parent_inode
        or parent_stat.st_uid != expected_uid
        or parent_stat.st_gid != expected_gid
        or stat.S_IMODE(parent_stat.st_mode) != expected_mode
        or parent_stat.st_nlink != expected_parent_nlink
    ):
        raise OSError("target parent identity drift")
    fd = os.open(
        b".",
        os.O_WRONLY | os.O_TMPFILE | os.O_CLOEXEC | os.O_NOFOLLOW,
        0o600,
        dir_fd=dirfd,
    )
    remaining = memoryview(payload)
    while remaining:
        written = os.write(fd, remaining)
        if written <= 0:
            raise OSError("short O_TMPFILE write")
        remaining = remaining[written:]
    os.fchmod(fd, 0o600)
    os.fsync(fd)
    if fail_after_fsync:
        raise OSError("injected failure after payload fsync")

    libc = ctypes.CDLL(None, use_errno=True)
    linkat = libc.linkat
    linkat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    linkat.restype = ctypes.c_int
    procfd = f"/proc/self/fd/{fd}".encode("ascii")
    ctypes.set_errno(0)
    result = linkat(-100, ctypes.c_char_p(procfd), dirfd, ctypes.c_char_p(name), 0x400)
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number), os.fsdecode(target))
    os.fsync(dirfd)
finally:
    if fd >= 0:
        os.close(fd)
    os.close(dirfd)
' "$pathname"
}

capture_generator_payload() {
  local generator=$1
  local sentinel='__A2_GENERATOR_COMPLETE_d4360775194aaf8593a9fa5db10cf7465b222534__'
  if ! declare -F "$generator" >/dev/null; then
    die "unknown evidence generator: $generator"
    return 1
  fi
  if ! CAPTURED_PAYLOAD=$("$generator" && printf '%s' "$sentinel"); then
    die "evidence generator failed: $generator"
    return 1
  fi
  case "$CAPTURED_PAYLOAD" in
    *"$sentinel") ;;
    *)
      die "evidence generator completion sentinel missing: $generator"
      return 1
      ;;
  esac
  CAPTURED_PAYLOAD=${CAPTURED_PAYLOAD%"$sentinel"}
}

publish_generator_noclobber() {
  local pathname=$1
  local generator=$2
  local expected_device=$3
  local expected_parent_inode=$4
  local expected_uid=$5
  local expected_gid=$6
  local expected_mode=$7
  local expected_parent_nlink=$8
  capture_generator_payload "$generator" || return 1
  atomic_noclobber_bytes \
    "$pathname" "$CAPTURED_PAYLOAD" "$expected_device" "$expected_parent_inode" \
    "$expected_uid" "$expected_gid" "$expected_mode" "$expected_parent_nlink"
}

if test "${BDFZ_A2_RESUME_LIBRARY_ONLY:-0}" = 1; then
  :
else
  test "$(uname -s)" = Linux || die 'the live protocol requires Linux coreutils'
  test "$#" -eq 5 || die 'usage: <inspect|seal|finish-seal> <protocol-commit> <runbook-blob> <test-blob> <script-blob>'

  ACTION=$1
  REPAIR_PROTOCOL_COMMIT=$2
  REPAIR_RUNBOOK_BLOB=$3
  REPAIR_TEST_BLOB=$4
  RESUME_SCRIPT_BLOB=$5
  EXPECTED_SOURCE_COMMIT=d4360775194aaf8593a9fa5db10cf7465b222534
  EXPECTED_DEVICE=66306
  EXPECTED_INODE=41854512
  EXPECTED_MODE=500
  EXPECTED_UID=1000
  EXPECTED_GID=1000
  EXPECTED_NLINK=4
  EXPECTED_WORKSPACE_FILE_COUNT=50
  EXPECTED_APPLEDOUBLE_COUNT=27
  EXPECTED_SEALED_MANIFEST_LINES=58
  EXPECTED_FINAL_MANIFEST_LINES=49
  EXPECTED_EVIDENCE_INODE=41854492
  EXPECTED_INCIDENT_INODE=43669283
  EXPECTED_AUTHORITY_INODE=41854486
  EXPECTED_AUTHORITY_PREVIEW_SHA256=0e12e99619af4207aa8f21fc8f0c8ac75826a20f5f347bd67908b0336e1f02f9
  EXPECTED_GRANT_PREVIEW_SHA256=8ac1ea3624f911b3088ddadc719d340f6c72cebd453f3f4758426adb539308d1
  EXPECTED_ISSUANCE_BASENAME=791ad258ee227f1fbc5646a91812b2900ec2d0eef04da885ffc1b3f6b5a960a8.issuance.json
  RUN_ROOT=/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess
  WORKSPACE="$RUN_ROOT/workspace-a-r2"
  INPUT="$RUN_ROOT/input/pdfs-verified"
  MANIFEST="$RUN_ROOT/manifests/offload-shard-a.json"
  A1="$RUN_ROOT/output/production-p4-mb16-shard-a-r1"
  A2="$RUN_ROOT/output/production-p1-mb16-shard-a-r2"
  AUTHORITY="$RUN_ROOT/input/timeout-recovery-authority-v1"
  MONITOR_DIR="$RUN_ROOT/monitor-a-r2"
  LOCK="$RUN_ROOT/.a2-lifecycle.lock"
  EVIDENCE_POINTER="$RUN_ROOT/.a2-current-evidence"
  EVIDENCE="$RUN_ROOT/a2-deploy-evidence/20260719T003812Z"
  INCIDENT="$EVIDENCE/incidents/appledouble-preclaim-d4360775"
  QUARANTINED_WORKSPACE="$INCIDENT/workspace-a-r2-contaminated"

  require_hex40() {
    printf '%s\n' "$1" | grep -Eq '^[0-9a-f]{40}$' || die "invalid Git identity: $1"
  }

  assert_real_directory() {
    local pathname=$1
    local expected_mode=$2
    local expected_uid=$3
    test -d "$pathname" || die "missing directory: $pathname"
    test ! -L "$pathname" || die "directory symlink rejected: $pathname"
    test "$(realpath -e "$pathname")" = "$pathname" || die "non-canonical directory: $pathname"
    test "$(stat -c %a "$pathname")" = "$expected_mode" || die "directory mode drift: $pathname"
    test "$(stat -c %u "$pathname")" = "$expected_uid" || die "directory owner drift: $pathname"
  }

  assert_canonical_sha256_sidecar() {
    local raw=$1
    local sidecar=$2
    local expected
    expected="$(sha256_value "$raw")  $(basename "$raw")"
    test "$(wc -l < "$sidecar")" -eq 1 || die "hash sidecar line-count drift: $sidecar"
    cmp -s "$sidecar" <(printf '%s\n' "$expected") || die "non-canonical hash sidecar: $sidecar"
  }

  assert_exact_authority_top_level() {
    shopt -s dotglob nullglob
    local -a expected=(
      "$EXPECTED_ISSUANCE_BASENAME"
      "$EXPECTED_ISSUANCE_BASENAME.sha256"
      ledger-identity.json
      ledger-identity.json.sha256
    )
    local -a actual=("$AUTHORITY"/*)
    test "${#actual[@]}" -eq "${#expected[@]}" || die 'authority entry count drift'
    local pathname name found expected_name
    for pathname in "${actual[@]}"; do
      name=${pathname##*/}
      found=0
      for expected_name in "${expected[@]}"; do
        if test "$name" = "$expected_name"; then
          found=1
          break
        fi
      done
      test "$found" -eq 1 || die "unexpected authority entry: $name"
      test -f "$pathname" && test ! -L "$pathname" || die "authority entry type drift: $name"
    done
  }

  assert_original_incident_evidence() {
    assert_real_directory "$INCIDENT" 700 "$EXPECTED_UID"
    test "$(stat -c %d "$INCIDENT")" = "$EXPECTED_DEVICE" \
      || die 'incident and workspace are not on the same filesystem'
    test "$(stat -c %i "$INCIDENT")" = "$EXPECTED_INCIDENT_INODE" || die 'incident inode drift'
    test "$(stat -c %g "$INCIDENT")" = "$EXPECTED_GID" || die 'incident group drift'
    local row name size digest pathname
    local -a rows=(
      'incident.env|154|0778100150e42d01468d1e19eae1a7cf5c9c335d7c7a972f3db526d0ef14c457'
      'repair-protocol.env|169|885d16fba3ad40a01e4ec8ef6937142f353e8ac3ae819780f45019e3832d8c22'
      'appledouble-files.txt|1186|f2756ed52d9bf4f3e4464e907ed119b1a8a23977332722f18b13f086e3e38eea'
      'appledouble-files.SHA256SUMS|2968|27b2ce45927002f8495bbb60751c904b298a8010971a8ca3bb2fd2a3c55d0555'
      'contaminated-workspace-seals.sha256|678|0343b25473bcd269552fcf48a200cbcf0da10c4e4f08f0edff6583ed578cce8d'
      'workspace-stat-before.env|59|922f6a32418f3e0269324ff5222acb8e24b423fd91cb6ac31f8186f356c6b939'
    )
    for row in "${rows[@]}"; do
      IFS='|' read -r name size digest <<< "$row"
      pathname="$INCIDENT/$name"
      assert_exact_regular_file "$pathname" 600 "$EXPECTED_UID" 1 "$size" "$digest"
      test "$(stat -c %g "$pathname")" = "$EXPECTED_GID" || die "group drift: $pathname"
    done
    local expected_stat
    expected_stat='device=66306\ninode=41854512\nmode=500\nuid=1000\ngid=1000'
    cmp -s "$INCIDENT/workspace-stat-before.env" <(printf '%s\n' "$expected_stat") \
      || die 'workspace-stat-before literal bytes drifted'
  }

  generate_authority_preview() {
    /usr/bin/node "$ACTIVE_WORKSPACE_FOR_PREVIEW/scripts/provision-timeout-recovery-authority.mjs" \
      --input-root "$INPUT"
  }

  generate_grant_preview() {
    /usr/bin/node "$ACTIVE_WORKSPACE_FOR_PREVIEW/scripts/prepare-timeout-recovery-grant.mjs" \
      --manifest "$MANIFEST" --predecessor-root "$A1" --ledger-root "$AUTHORITY"
  }

  assert_deterministic_preview() {
    local generator=$1
    local expected_sha256=$2
    capture_generator_payload "$generator"
    local first=$CAPTURED_PAYLOAD
    capture_generator_payload "$generator"
    test "$CAPTURED_PAYLOAD" = "$first" || die "non-deterministic read-only preview: $generator"
    local actual_sha256
    actual_sha256=$(printf '%s' "$first" | sha256sum | awk '{print $1}')
    test "$actual_sha256" = "$expected_sha256" || die "read-only preview identity drift: $generator"
    printf '%s' "$first" \
      | jq -e '.status == "verified_idempotent" and (.planned_writes | length == 0)' >/dev/null \
      || die "read-only preview no longer reports verified idempotence: $generator"
  }

  assert_authority_boundary() {
    local active_workspace=$1
    assert_real_directory "$AUTHORITY" 700 "$EXPECTED_UID"
    test "$(stat -c %d "$AUTHORITY")" = "$EXPECTED_DEVICE" || die 'authority device drift'
    test "$(stat -c %i "$AUTHORITY")" = "$EXPECTED_AUTHORITY_INODE" || die 'authority inode drift'
    test "$(stat -c %g "$AUTHORITY")" = "$EXPECTED_GID" || die 'authority group drift'
    test "$(stat -c %h "$AUTHORITY")" = 2 || die 'authority link-count drift'
    assert_exact_authority_top_level

    local row name size digest pathname
    local -a rows=(
      'ledger-identity.json|302|df77305d01249d59323b76bafeb46cf1a09da30cd90a88602b238c5fa8d62c0c'
      'ledger-identity.json.sha256|87|5344d6a8ace3273eb253b81588959a08db92d3dd491411166835e6a50fe5ffa2'
      '791ad258ee227f1fbc5646a91812b2900ec2d0eef04da885ffc1b3f6b5a960a8.issuance.json|2356|984f511d726873496f6efac6b16ad7691e91a12b11ee9e8fc67667bf854bd9e7'
      '791ad258ee227f1fbc5646a91812b2900ec2d0eef04da885ffc1b3f6b5a960a8.issuance.json.sha256|145|3ee8d0009b407c435e9bb8e90f7cb7a6fade2c1fa22772b750697e3962713655'
    )
    for row in "${rows[@]}"; do
      IFS='|' read -r name size digest <<< "$row"
      pathname="$AUTHORITY/$name"
      assert_exact_regular_file "$pathname" 600 "$EXPECTED_UID" 1 "$size" "$digest"
      test "$(stat -c %g "$pathname")" = "$EXPECTED_GID" || die "group drift: $pathname"
    done
    assert_canonical_sha256_sidecar \
      "$AUTHORITY/ledger-identity.json" "$AUTHORITY/ledger-identity.json.sha256"
    assert_canonical_sha256_sidecar \
      "$AUTHORITY/$EXPECTED_ISSUANCE_BASENAME" "$AUTHORITY/$EXPECTED_ISSUANCE_BASENAME.sha256"
    (cd "$AUTHORITY" && sha256sum --check --strict --status ledger-identity.json.sha256) \
      || die 'authority identity seal failed'

    local grant="$A1/timeout-recovery-grant.json"
    assert_exact_regular_file \
      "$grant" 600 "$EXPECTED_UID" 1 4968 \
      d52aafa542d7c9321158c74716ebc08d4e364356b216804856edac1e91cd5338
    assert_exact_regular_file \
      "$grant.sha256" 600 "$EXPECTED_UID" 1 94 \
      13fafe700d9c14de97d7746e84879e2b4a3734a79c031b120b52cbc5a62ab6c2
    test "$(stat -c %g "$grant")" = "$EXPECTED_GID" || die 'grant group drift'
    test "$(stat -c %g "$grant.sha256")" = "$EXPECTED_GID" || die 'grant sidecar group drift'
    assert_canonical_sha256_sidecar "$grant" "$grant.sha256"
    (cd "$A1" && sha256sum --check --strict --status timeout-recovery-grant.json.sha256) \
      || die 'grant seal failed'
    test "$(jq -r '.consumption.ledger_root' "$grant")" = "$AUTHORITY" || die 'grant authority path drift'
    test "$(jq -r '.consumption.ledger_device' "$grant")" = "$(stat -c %d "$AUTHORITY")" \
      || die 'grant authority device drift'
    test "$(jq -r '.consumption.ledger_inode' "$grant")" = "$(stat -c %i "$AUTHORITY")" \
      || die 'grant authority inode drift'

    shopt -s nullglob
    local -a claim_files=("$AUTHORITY"/*.claim.json)
    local -a claim_seals=("$AUTHORITY"/*.claim.json.sha256)
    (cd "$AUTHORITY" && sha256sum --check --strict --status "$EXPECTED_ISSUANCE_BASENAME.sha256") \
      || die 'issuance seal failed'
    AUTHORITY_CLAIM_COUNT=${#claim_files[@]}
    test "$AUTHORITY_CLAIM_COUNT" -eq 0 || die 'authority claim already exists'
    test "${#claim_seals[@]}" -eq 0 || die 'authority claim seal already exists'
    local -a grant_temps=(
      "$A1"/.timeout-recovery-grant.json.publish-*.tmp
      "$A1"/.timeout-recovery-grant.json.sha256.publish-*.tmp
    )
    test "${#grant_temps[@]}" -eq 0 || die 'grant publication temp exists'

    test ! -e "$A2" && test ! -L "$A2" || die 'A2 output already exists'
    test ! -e "$MONITOR_DIR" && test ! -L "$MONITOR_DIR" || die 'A2 monitor directory already exists'
    test ! -e "$LOCK" && test ! -L "$LOCK" || die 'A2 lifecycle lock already exists'
    local -a runtime_paths=(
      "$HOME/.config/systemd/user/curriculum-ocr-reprocess-a-r2.service"
      "$HOME/.config/systemd/user/curriculum-ocr-reprocess-a-r2-cleanup.service"
      "$HOME/.config/systemd/user/curriculum-ocr-reprocess-a-r2-monitor.service"
      "$HOME/.config/systemd/user/curriculum-ocr-reprocess-a-r2-monitor.timer"
      "$HOME/.config/systemd/user/curriculum-ocr-reprocess-a-r2-monitor.service.d/alert-only.conf"
      "$HOME/.config/bdfz/curriculum-ocr-reprocess-a-r2-cleanup.conf"
    )
    local runtime_path
    for runtime_path in "${runtime_paths[@]}"; do
      test ! -e "$runtime_path" && test ! -L "$runtime_path" || die "A2 runtime path already exists: $runtime_path"
    done
    local -a units=(
      curriculum-ocr-reprocess-a-r2.service
      curriculum-ocr-reprocess-a-r2-cleanup.service
      curriculum-ocr-reprocess-a-r2-monitor.service
      curriculum-ocr-reprocess-a-r2-monitor.timer
    )
    local unit load_state
    for unit in "${units[@]}"; do
      load_state=$(systemctl --user show "$unit" --property=LoadState --value 2>/dev/null) \
        || die "could not inspect unit: $unit"
      test "$load_state" = not-found || die "A2 unit is already loaded: $unit"
    done

    local -a evidence_rows=(
      'a1-pregrant.SHA256SUMS|647698|7d569e8e4f752b9db7f163c75957a33dc13401201a37a34ccb58e35bc56952fc'
      'a1-pregrant.SHA256SUMS.sha256|199|e64d33780bd0cc3cb590a69a82781604d988bd067ebb51983efce9e3523b3e14'
      'authority-grant-evidence.SHA256SUMS|596|7ee6d31aa895610cc4f08fea197d470c9bb846645c30383ab5072ec7af14ae74'
      'workspace-SHA256SUMS.sha256|166|f0cb57258eb8095a475d786af0b1fd35b859c303de34847e9e71f9b9ee98d6d5'
      'a1-anchors.env.sha256|191|319dcfc91564e7996e4bfda63e60c50c64e65ec53ab37270b9cd4c076e1cb885'
    )
    for row in "${evidence_rows[@]}"; do
      IFS='|' read -r name size digest <<< "$row"
      pathname="$EVIDENCE/$name"
      assert_exact_regular_file "$pathname" 600 "$EXPECTED_UID" 1 "$size" "$digest"
      test "$(stat -c %g "$pathname")" = "$EXPECTED_GID" || die "group drift: $pathname"
    done

    sha256sum --check --strict --status "$EVIDENCE/a1-pregrant.SHA256SUMS.sha256" \
      || die 'A1 pregrant manifest seal failed'
    (cd "$A1" && sha256sum --check --strict --status "$EVIDENCE/a1-pregrant.SHA256SUMS") \
      || die 'A1 pregrant tree failed'
    sha256sum --check --strict --status "$EVIDENCE/authority-grant-evidence.SHA256SUMS" \
      || die 'authority/grant evidence failed'
    cmp -s "$EVIDENCE/workspace-SHA256SUMS.sha256" <(
      printf '%s  %s\n' \
        6c056bbed153b1cca897d8ddb270ff3456ff52437d09d9c25fd1d5537cf43fbb \
        "$WORKSPACE/SHA256SUMS"
    ) || die 'workspace evidence sidecar byte drift'
    test "$(sha256_value "$active_workspace/SHA256SUMS")" \
      = 6c056bbed153b1cca897d8ddb270ff3456ff52437d09d9c25fd1d5537cf43fbb \
      || die 'active workspace evidence seal failed'
    sha256sum --check --strict --status "$EVIDENCE/a1-anchors.env.sha256" \
      || die 'A1 anchor evidence seal failed'

    ACTIVE_WORKSPACE_FOR_PREVIEW=$active_workspace
    assert_deterministic_preview generate_authority_preview "$EXPECTED_AUTHORITY_PREVIEW_SHA256"
    assert_deterministic_preview generate_grant_preview "$EXPECTED_GRANT_PREVIEW_SHA256"
  }

  assert_workspace_metadata() {
    local active=$1
    /usr/bin/python3 - "$active" "$EXPECTED_DEVICE" "$EXPECTED_INODE" \
      "$EXPECTED_UID" "$EXPECTED_GID" "$EXPECTED_MODE" \
      "$EXPECTED_WORKSPACE_FILE_COUNT" "$EXPECTED_APPLEDOUBLE_COUNT" <<'PY'
import os
import stat
import sys

root = os.path.abspath(sys.argv[1])
expected_device = int(sys.argv[2])
expected_inode = int(sys.argv[3])
expected_uid = int(sys.argv[4])
expected_gid = int(sys.argv[5])
expected_dir_mode = int(sys.argv[6], 8)
expected_file_count = int(sys.argv[7])
expected_appledouble_count = int(sys.argv[8])

root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
try:
    root_before = os.fstat(root_fd)
    directories = {}
    files = set()
    appledouble = set()
    for dirpath, dirnames, filenames, dirfd in os.fwalk(root, topdown=True, follow_symlinks=False):
        relative_dir = os.path.relpath(dirpath, root)
        directory_info = os.fstat(dirfd)
        if (
            not stat.S_ISDIR(directory_info.st_mode)
            or directory_info.st_dev != expected_device
            or directory_info.st_uid != expected_uid
            or directory_info.st_gid != expected_gid
            or stat.S_IMODE(directory_info.st_mode) != expected_dir_mode
        ):
            raise SystemExit(f"directory metadata drift: {relative_dir}")
        directories[relative_dir] = directory_info
        for name in dirnames:
            info = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
            if not stat.S_ISDIR(info.st_mode) or info.st_dev != expected_device:
                raise SystemExit(f"linked, mounted, or special directory rejected: {relative_dir}/{name}")
        for name in filenames:
            info = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
            relative_file = name if relative_dir == "." else f"{relative_dir}/{name}"
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_dev != expected_device
                or info.st_uid != expected_uid
                or info.st_gid != expected_gid
                or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != 0o400
            ):
                raise SystemExit(f"regular-file metadata drift: {relative_file}")
            files.add(relative_file)
            if name.startswith("._"):
                appledouble.add(relative_file)

    if len(files) != expected_file_count:
        raise SystemExit("workspace file count drift")
    if len(appledouble) != expected_appledouble_count:
        raise SystemExit("AppleDouble count drift")

    required_directories = {"."}
    for relative_file in files:
        parent = os.path.dirname(relative_file)
        while parent:
            required_directories.add(parent)
            parent = os.path.dirname(parent)
    if set(directories) != required_directories:
        raise SystemExit("workspace contains an empty or unexpected directory")

    for relative_dir, info in directories.items():
        child_count = sum(
            1
            for candidate in directories
            if candidate != "." and (os.path.dirname(candidate) or ".") == relative_dir
        )
        if info.st_nlink != 2 + child_count:
            raise SystemExit(f"directory link-count drift: {relative_dir}")

    root_after = os.fstat(root_fd)
    if (
        root_before.st_dev != expected_device
        or root_before.st_ino != expected_inode
        or root_after.st_dev != root_before.st_dev
        or root_after.st_ino != root_before.st_ino
        or root_after.st_mode != root_before.st_mode
        or root_after.st_uid != root_before.st_uid
        or root_after.st_gid != root_before.st_gid
        or root_after.st_nlink != root_before.st_nlink
    ):
        raise SystemExit("workspace root changed during metadata walk")
finally:
    os.close(root_fd)
PY
  }

  generate_workspace_manifest() {
    (
      set -o pipefail
      cd "$ACTIVE_WORKSPACE_FOR_MANIFEST"
      find . -type f ! -path ./SHA256SUMS -print0 \
        | LC_ALL=C sort -z | xargs -0 -r sha256sum
    )
  }

  assert_workspace_tree() {
    local active=$1
    assert_real_directory "$active" "$EXPECTED_MODE" "$EXPECTED_UID"
    test "$(stat -c %d "$active")" = "$EXPECTED_DEVICE" || die 'workspace device drift'
    test "$(stat -c %i "$active")" = "$EXPECTED_INODE" || die 'workspace inode drift'
    test "$(stat -c %g "$active")" = "$EXPECTED_GID" || die 'workspace group drift'
    test "$(stat -c %h "$active")" = "$EXPECTED_NLINK" || die 'workspace link-count drift'
    cmp -s "$active/SOURCE_COMMIT" <(printf '%s\n' "$EXPECTED_SOURCE_COMMIT") \
      || die 'workspace source commit drift'
    assert_workspace_metadata "$active"
    test "$(sha256_value "$active/SOURCE_SHA256SUMS")" \
      = 66945b189a6ead9b5864afc340b9e93cd1cafac69d5f0469c91d755815d32902 \
      || die 'workspace source manifest identity drift'
    test "$(sha256_value "$active/SHA256SUMS")" \
      = 6c056bbed153b1cca897d8ddb270ff3456ff52437d09d9c25fd1d5537cf43fbb \
      || die 'workspace final manifest identity drift'
    test "$(wc -l < "$active/SHA256SUMS")" -eq "$EXPECTED_FINAL_MANIFEST_LINES" \
      || die 'workspace final manifest line-count drift'
    ACTIVE_WORKSPACE_FOR_MANIFEST=$active
    capture_generator_payload generate_workspace_manifest
    cmp -s "$active/SHA256SUMS" <(printf '%s' "$CAPTURED_PAYLOAD") \
      || die 'workspace final manifest does not cover the exact file tree'
    (cd "$active" && sha256sum --check --strict --status SOURCE_SHA256SUMS) \
      || die 'workspace source manifest failed'
    (cd "$active" && sha256sum --check --strict --status SHA256SUMS) \
      || die 'workspace seal manifest failed'
    test "$(wc -l < "$INCIDENT/appledouble-files.txt")" -eq "$EXPECTED_APPLEDOUBLE_COUNT" \
      || die 'AppleDouble path-list count drift'
    test "$(wc -l < "$INCIDENT/appledouble-files.SHA256SUMS")" -eq "$EXPECTED_APPLEDOUBLE_COUNT" \
      || die 'AppleDouble manifest count drift'
    (cd "$active" && sha256sum --check --strict --status "$INCIDENT/appledouble-files.SHA256SUMS") \
      || die 'AppleDouble hash set drift'

    local expected_hash original_path relative_path actual_hash seal_count=0
    while read -r expected_hash original_path; do
      case "$original_path" in
        "$WORKSPACE"/*) ;;
        *) die 'contaminated workspace seal escaped the original workspace'; return 1 ;;
      esac
      relative_path=${original_path#"$WORKSPACE"/}
      test -f "$active/$relative_path" && test ! -L "$active/$relative_path" \
        || die "sealed workspace file missing: $relative_path"
      actual_hash=$(sha256_value "$active/$relative_path")
      test "$actual_hash" = "$expected_hash" || die "sealed workspace file drift: $relative_path"
      seal_count=$((seal_count + 1))
    done < "$INCIDENT/contaminated-workspace-seals.sha256"
    test "$seal_count" -eq 4 || die 'contaminated workspace seal count drift'
  }

  expected_resume_protocol() {
    printf 'schema_version=1\nstate=appledouble_quarantine_sealed\nsource_commit=%s\nrepair_protocol_commit=%s\nrunbook_blob=%s\ntest_blob=%s\nresume_script_blob=%s\nworkspace_device=%s\nworkspace_inode=%s\ncitation_allowed=false\n' \
      "$EXPECTED_SOURCE_COMMIT" "$REPAIR_PROTOCOL_COMMIT" "$REPAIR_RUNBOOK_BLOB" \
      "$REPAIR_TEST_BLOB" "$RESUME_SCRIPT_BLOB" "$EXPECTED_DEVICE" "$EXPECTED_INODE"
  }

  expected_workspace_stat() {
    printf 'device=%s\\ninode=%s\\nmode=%s\\nuid=%s\\ngid=%s\n' \
      "$EXPECTED_DEVICE" "$EXPECTED_INODE" "$EXPECTED_MODE" "$EXPECTED_UID" "$EXPECTED_GID"
  }

  assert_new_evidence_metadata() {
    local pathname=$1
    test -f "$pathname" && test ! -L "$pathname" || die "sealed evidence missing: $pathname"
    test "$(stat -c %a "$pathname")" = 600 || die "sealed evidence mode drift: $pathname"
    test "$(stat -c %u "$pathname")" = "$EXPECTED_UID" || die "sealed evidence owner drift: $pathname"
    test "$(stat -c %g "$pathname")" = "$EXPECTED_GID" || die "sealed evidence group drift: $pathname"
    test "$(stat -c %h "$pathname")" = 1 || die "sealed evidence link-count drift: $pathname"
  }

  assert_partial_seal_evidence() {
    local resume="$INCIDENT/resume-protocol.env"
    local after="$INCIDENT/workspace-stat-after.env"
    local manifest="$INCIDENT/QUARANTINE_EVIDENCE_SHA256SUMS"
    local sidecar="$manifest.sha256"
    if test -e "$resume" || test -L "$resume"; then
      assert_new_evidence_metadata "$resume"
      cmp -s "$resume" <(expected_resume_protocol) || die 'resume protocol identity drift'
    fi
    if test -e "$after" || test -L "$after"; then
      test -f "$resume" && test ! -L "$resume" || die 'workspace-stat-after appeared before resume protocol'
      assert_new_evidence_metadata "$after"
      cmp -s "$after" <(expected_workspace_stat) || die 'workspace-stat-after literal bytes drift'
    fi
    if test -e "$manifest" || test -L "$manifest"; then
      test -f "$after" && test ! -L "$after" || die 'recursive manifest appeared before workspace-stat-after'
      assert_new_evidence_metadata "$manifest"
      test "$(wc -l < "$manifest")" -eq "$EXPECTED_SEALED_MANIFEST_LINES" \
        || die 'sealed recursive manifest count drift'
      capture_generator_payload generate_recursive_manifest
      cmp -s "$manifest" <(printf '%s' "$CAPTURED_PAYLOAD") \
        || die 'sealed recursive manifest no longer covers the exact tree'
      (cd "$INCIDENT" && sha256sum --check --strict --status "$(basename "$manifest")") \
        || die 'sealed recursive manifest failed'
    fi
    if test -e "$sidecar" || test -L "$sidecar"; then
      test -f "$manifest" && test ! -L "$manifest" || die 'manifest sidecar appeared before its manifest'
      assert_new_evidence_metadata "$sidecar"
      assert_canonical_sha256_sidecar "$manifest" "$sidecar"
      (cd "$INCIDENT" && sha256sum --check --strict --status "$(basename "$sidecar")") \
        || die 'sealed recursive manifest sidecar failed'
    fi
  }

  assert_sealed_evidence() {
    assert_partial_seal_evidence
    local pathname
    for pathname in \
      "$INCIDENT/resume-protocol.env" \
      "$INCIDENT/workspace-stat-after.env" \
      "$INCIDENT/QUARANTINE_EVIDENCE_SHA256SUMS" \
      "$INCIDENT/QUARANTINE_EVIDENCE_SHA256SUMS.sha256"; do
      assert_new_evidence_metadata "$pathname"
    done
  }

  assert_capabilities() {
    test "$(command -v flock)" = /usr/bin/flock || die 'unexpected flock implementation'
    test "$(command -v mv)" = /usr/bin/mv || die 'unexpected mv implementation'
    test "$(command -v find)" = /usr/bin/find || die 'unexpected find implementation'
    test "$(command -v sha256sum)" = /usr/bin/sha256sum || die 'unexpected sha256sum implementation'
    test "$(command -v jq)" = /usr/bin/jq || die 'unexpected jq implementation'
    test "$(command -v node)" = /usr/bin/node || die 'unexpected node implementation'
    test "$(command -v python3)" = /usr/bin/python3 || die 'unexpected python3 implementation'
    test "$(command -v sudo)" = /usr/bin/sudo || die 'unexpected sudo implementation'
    local mv_help
    mv_help=$(/usr/bin/mv --help) || die 'could not inspect GNU mv capabilities'
    grep -Fq -- '--no-copy' <<< "$mv_help" || die 'GNU mv lacks --no-copy'
    test -d /proc/self/fd || die '/proc/self/fd is unavailable'
    /usr/bin/python3 -c '
import ctypes
import os
if not hasattr(os, "O_TMPFILE"):
    raise SystemExit(1)
if not hasattr(ctypes.CDLL(None), "linkat"):
    raise SystemExit(1)
' >/dev/null || die 'atomic publication capabilities are unavailable'
  }

  probe_target_otmpfile() {
    local expected_nlink=$1
    /usr/bin/python3 - "$INCIDENT" "$EXPECTED_DEVICE" "$EXPECTED_INCIDENT_INODE" \
      "$EXPECTED_UID" "$EXPECTED_GID" 700 "$expected_nlink" <<'PY'
import os
import stat
import sys

parent = os.fsencode(sys.argv[1])
expected = (
    int(sys.argv[2]),
    int(sys.argv[3]),
    int(sys.argv[4]),
    int(sys.argv[5]),
    int(sys.argv[6], 8),
    int(sys.argv[7]),
)
dirfd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
fd = -1
try:
    info = os.fstat(dirfd)
    observed = (
        info.st_dev,
        info.st_ino,
        info.st_uid,
        info.st_gid,
        stat.S_IMODE(info.st_mode),
        info.st_nlink,
    )
    if observed != expected:
        raise OSError("target parent identity drift before O_TMPFILE probe")
    fd = os.open(
        b".",
        os.O_WRONLY | os.O_TMPFILE | os.O_CLOEXEC | os.O_NOFOLLOW,
        0o600,
        dir_fd=dirfd,
    )
    os.write(fd, b"capability-probe")
    os.fsync(fd)
finally:
    if fd >= 0:
        os.close(fd)
    os.close(dirfd)
PY
  }

  assert_all_invariants() {
    assert_capabilities
    test "$(id -u)" = "$EXPECTED_UID" || die 'unexpected operator uid'
    test "$(id -g)" = "$EXPECTED_GID" || die 'unexpected operator gid'
    local expected_pointer_size expected_pointer_sha256
    expected_pointer_size=$(printf '%s\n' "$EVIDENCE" | wc -c | tr -d '[:space:]')
    expected_pointer_sha256=$(printf '%s\n' "$EVIDENCE" | sha256sum | awk '{print $1}')
    assert_exact_regular_file "$EVIDENCE_POINTER" 600 "$EXPECTED_UID" 1 \
      "$expected_pointer_size" "$expected_pointer_sha256"
    test "$(stat -c %g "$EVIDENCE_POINTER")" = "$EXPECTED_GID" || die 'evidence pointer group drift'
    cmp -s "$EVIDENCE_POINTER" <(printf '%s\n' "$EVIDENCE") || die 'evidence pointer byte drift'
    assert_real_directory "$EVIDENCE" 700 "$EXPECTED_UID"
    test "$(stat -c %d "$EVIDENCE")" = "$EXPECTED_DEVICE" || die 'evidence directory device drift'
    test "$(stat -c %i "$EVIDENCE")" = "$EXPECTED_EVIDENCE_INODE" || die 'evidence directory inode drift'
    test "$(stat -c %g "$EVIDENCE")" = "$EXPECTED_GID" || die 'evidence directory group drift'
    test "$(stat -c %h "$EVIDENCE")" = 3 || die 'evidence directory link-count drift'
    assert_original_incident_evidence
    local state active
    state=$(classify_state "$WORKSPACE" "$QUARANTINED_WORKSPACE" "$EXPECTED_DEVICE" "$EXPECTED_INODE" "$INCIDENT")
    assert_exact_incident_top_level "$INCIDENT" "$state"
    if test "$state" = PREMOVE_READY; then
      active=$WORKSPACE
      test "$(stat -c %h "$INCIDENT")" = 2 || die 'pre-move incident link-count drift'
    else
      active=$QUARANTINED_WORKSPACE
      test "$(stat -c %h "$INCIDENT")" = 3 || die 'post-move incident link-count drift'
    fi
    assert_workspace_tree "$active"
    assert_authority_boundary "$active"
    if test "$state" = MOVED_UNSEALED; then assert_partial_seal_evidence; fi
    if test "$state" = SEALED; then assert_sealed_evidence; fi
    printf '%s\n' "$state"
  }

  generate_recursive_manifest() {
    (
      set -o pipefail
      cd "$INCIDENT"
      find . -type f \
        ! -path ./QUARANTINE_EVIDENCE_SHA256SUMS \
        ! -path ./QUARANTINE_EVIDENCE_SHA256SUMS.sha256 \
        -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
    )
  }

  generate_recursive_manifest_sidecar() {
    (cd "$INCIDENT" && sha256sum QUARANTINE_EVIDENCE_SHA256SUMS)
  }

  publish_incident_evidence() {
    local pathname=$1
    local generator=$2
    publish_generator_noclobber \
      "$pathname" "$generator" "$EXPECTED_DEVICE" "$EXPECTED_INCIDENT_INODE" \
      "$EXPECTED_UID" "$EXPECTED_GID" 700 3
  }

  assert_post_move_prefix() {
    local state
    state=$(classify_state \
      "$WORKSPACE" "$QUARANTINED_WORKSPACE" "$EXPECTED_DEVICE" "$EXPECTED_INODE" "$INCIDENT")
    case "$state" in
      MOVED_UNSEALED|SEALED) ;;
      *) die "post-move incident left its resumable state: $state"; return 1 ;;
    esac
    test "$(stat -c %d "$INCIDENT")" = "$EXPECTED_DEVICE" || die 'post-move incident device drift'
    test "$(stat -c %i "$INCIDENT")" = "$EXPECTED_INCIDENT_INODE" || die 'post-move incident inode drift'
    test "$(stat -c %a "$INCIDENT")" = 700 || die 'post-move incident mode drift'
    test "$(stat -c %u "$INCIDENT")" = "$EXPECTED_UID" || die 'post-move incident owner drift'
    test "$(stat -c %g "$INCIDENT")" = "$EXPECTED_GID" || die 'post-move incident group drift'
    test "$(stat -c %h "$INCIDENT")" = 3 || die 'post-move incident link-count drift'
    assert_exact_incident_top_level "$INCIDENT" "$state"
    assert_workspace_metadata "$QUARANTINED_WORKSPACE"
    assert_partial_seal_evidence
  }

  seal_moved_workspace() {
    test "$(classify_state "$WORKSPACE" "$QUARANTINED_WORKSPACE" "$EXPECTED_DEVICE" "$EXPECTED_INODE" "$INCIDENT")" = MOVED_UNSEALED \
      || die 'workspace is not in MOVED_UNSEALED state'
    assert_post_move_prefix
    if test ! -e "$INCIDENT/resume-protocol.env" && test ! -L "$INCIDENT/resume-protocol.env"; then
      publish_incident_evidence "$INCIDENT/resume-protocol.env" expected_resume_protocol
    fi
    assert_post_move_prefix
    if test ! -e "$INCIDENT/workspace-stat-after.env" && test ! -L "$INCIDENT/workspace-stat-after.env"; then
      publish_incident_evidence "$INCIDENT/workspace-stat-after.env" expected_workspace_stat
    fi
    assert_post_move_prefix
    if test ! -e "$INCIDENT/QUARANTINE_EVIDENCE_SHA256SUMS" \
      && test ! -L "$INCIDENT/QUARANTINE_EVIDENCE_SHA256SUMS"; then
      publish_incident_evidence \
        "$INCIDENT/QUARANTINE_EVIDENCE_SHA256SUMS" generate_recursive_manifest
    fi
    assert_post_move_prefix
    if test ! -e "$INCIDENT/QUARANTINE_EVIDENCE_SHA256SUMS.sha256" \
      && test ! -L "$INCIDENT/QUARANTINE_EVIDENCE_SHA256SUMS.sha256"; then
      publish_incident_evidence \
        "$INCIDENT/QUARANTINE_EVIDENCE_SHA256SUMS.sha256" generate_recursive_manifest_sidecar
    fi
    assert_post_move_prefix
  }

  for identity in \
    "$REPAIR_PROTOCOL_COMMIT" "$REPAIR_RUNBOOK_BLOB" "$REPAIR_TEST_BLOB" "$RESUME_SCRIPT_BLOB"; do
    require_hex40 "$identity"
  done
  test "$REPAIR_PROTOCOL_COMMIT" != "$EXPECTED_SOURCE_COMMIT" || die 'repair protocol cannot equal the payload commit'
  case "$ACTION" in
    inspect)
      assert_all_invariants
      ;;
    seal)
      exec 9<"$INCIDENT"
      /usr/bin/flock --exclusive --nonblock 9 || die 'another seal operation holds the incident lock'
      test "$(assert_all_invariants)" = PREMOVE_READY || die 'seal requires PREMOVE_READY'
      /usr/bin/sudo -n /usr/bin/true >/dev/null 2>&1 || die 'non-interactive sudo is unavailable'
      probe_target_otmpfile 2 || die 'target filesystem lacks safe O_TMPFILE support'
      test "$(stat -c %d "$INCIDENT")" = "$EXPECTED_DEVICE" \
        || die 'incident filesystem changed immediately before move'
      test "$(stat -c %d "$WORKSPACE")" = "$EXPECTED_DEVICE" \
        || die 'workspace filesystem changed immediately before move'
      test ! -e "$QUARANTINED_WORKSPACE" && test ! -L "$QUARANTINED_WORKSPACE" \
        || die 'quarantine destination appeared immediately before move'
      move_status=0
      /usr/bin/sudo -n /usr/bin/mv -T --no-clobber --no-copy -- \
        "$WORKSPACE" "$QUARANTINED_WORKSPACE" || move_status=$?
      state=$(classify_state "$WORKSPACE" "$QUARANTINED_WORKSPACE" "$EXPECTED_DEVICE" "$EXPECTED_INODE" "$INCIDENT")
      case "$state" in
        MOVED_UNSEALED) seal_moved_workspace ;;
        SEALED) ;;
        PREMOVE_READY) die "atomic move did not occur (mv status $move_status)" ;;
        *) die "unexpected post-move state: $state" ;;
      esac
      test "$(assert_all_invariants)" = SEALED || die 'sealed evidence revalidation failed'
      printf '%s\n' SEALED
      ;;
    finish-seal)
      exec 9<"$INCIDENT"
      /usr/bin/flock --exclusive --nonblock 9 || die 'another seal operation holds the incident lock'
      test "$(assert_all_invariants)" = MOVED_UNSEALED || die 'finish-seal requires a separately inspected MOVED_UNSEALED state'
      probe_target_otmpfile 3 || die 'target filesystem lacks safe O_TMPFILE support'
      seal_moved_workspace
      test "$(assert_all_invariants)" = SEALED || die 'sealed evidence revalidation failed'
      printf '%s\n' SEALED
      ;;
    *) die "unknown action: $ACTION" ;;
  esac
fi
