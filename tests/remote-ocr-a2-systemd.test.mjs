import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const unit = (name) => readFile(new URL(`../ops/systemd/${name}`, import.meta.url), 'utf8');

test('A2 worker resumes only a committed canonical timeout-recovery seed under one lifecycle lock', async () => {
  const [worker, cleanup] = await Promise.all([
    unit('curriculum-ocr-reprocess-a-r2.service'),
    unit('curriculum-ocr-reprocess-a-r2-cleanup.service'),
  ]);
  const lifecycle = '/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/.a2-lifecycle.lock';
  assert.match(worker, new RegExp(`^ExecStart=/usr/bin/flock --no-fork --exclusive --wait 60 --conflict-exit-code 75 ${lifecycle.replaceAll('.', '\\.')}`, 'mu'));
  assert.match(cleanup, /^ExecStart=\/usr\/bin\/flock --no-fork --exclusive --wait 60 --conflict-exit-code 75 \$\{BDFZ_OCR_A2_LIFECYCLE_LOCK\}/mu);
  assert.match(worker, /--seed-from-output-root \/home\/suen\/curriculum-ocr-offload\/runs\/20260716T1520Z-partial14-reprocess\/output\/production-p4-mb16-shard-a-r1/u);
  assert.match(worker, /--timeout-recovery-ledger \/home\/suen\/curriculum-ocr-offload\/runs\/20260716T1520Z-partial14-reprocess\/input\/timeout-recovery-authority-v1/u);
  assert.match(worker, /^ExecStartPre=\/usr\/bin\/test -f .*production-p1-mb16-shard-a-r2\/seed-commit\.json$/mu);
  assert.match(worker, /^ExecStartPre=\/usr\/bin\/test -f .*production-p1-mb16-shard-a-r2\/timeout-recovery-consumption-claim\.json$/mu);
  assert.match(worker, /^OnSuccess=curriculum-ocr-reprocess-a-r2-cleanup\.service$/mu);
  assert.match(worker, /^RestartPreventExitStatus=2 12 75$/mu);
});

test('A2 worker fails startup when any mandatory runtime prerequisite is absent', async () => {
  const worker = await unit('curriculum-ocr-reprocess-a-r2.service');
  assert.doesNotMatch(worker, /^Condition(?:Path|File)/mu);
  const requiredChecks = [
    'ExecStartPre=/usr/bin/test -d /home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/workspace-a-r2',
    'ExecStartPre=/usr/bin/test -d /home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p4-mb16-shard-a-r1',
    'ExecStartPre=/usr/bin/test -d /home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p1-mb16-shard-a-r2',
    'ExecStartPre=/usr/bin/test -f /home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p1-mb16-shard-a-r2/seed-commit.json',
    'ExecStartPre=/usr/bin/test -f /home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p1-mb16-shard-a-r2/seed-commit.json.sha256',
    'ExecStartPre=/usr/bin/test -f /home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p1-mb16-shard-a-r2/timeout-recovery-grant.json',
    'ExecStartPre=/usr/bin/test -f /home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p1-mb16-shard-a-r2/timeout-recovery-grant.json.sha256',
    'ExecStartPre=/usr/bin/test -f /home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p1-mb16-shard-a-r2/timeout-recovery-consumption-claim.json',
    'ExecStartPre=/usr/bin/test -f /home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p1-mb16-shard-a-r2/timeout-recovery-consumption-claim.json.sha256',
  ];
  const lines = new Set(worker.split('\n'));
  for (const check of requiredChecks) assert.equal(lines.has(check), true, check);
});

test('A2 runtime is parallel-1, quality-first, and isolated from every predecessor worker', async () => {
  const [llama, worker] = await Promise.all([
    unit('curriculum-ocr-llama.service'),
    unit('curriculum-ocr-reprocess-a-r2.service'),
  ]);
  assert.match(llama, /--ctx-size 32768 --parallel 1 /u);
  assert.match(llama, /--temp 0 /u);
  assert.match(worker, /--vl-rec-max-concurrency 1 --server-parallel 1 --micro-batch 16 --use-queues/u);
  assert.match(worker, /--child-idle-timeout-seconds 1200/u);
  assert.doesNotMatch(worker, /--server-parallel 4/u);
  assert.match(worker, /^Conflicts=curriculum-ocr-reprocess@a\.service curriculum-ocr-reprocess@b\.service curriculum-ocr-reprocess-b-r2\.service curriculum-ocr-reprocess-b-r3\.service$/mu);
  assert.match(worker, /^TimeoutStartSec=4min$/mu);
  assert.match(worker, /^WantedBy=default\.target$/mu);
});

test('A2 monitor loads hash-sealed live A1 anchors and covers completion plus alerting', async () => {
  const [monitor, timer, dropIn, alertConfig] = await Promise.all([
    unit('curriculum-ocr-reprocess-a-r2-monitor.service'),
    unit('curriculum-ocr-reprocess-a-r2-monitor.timer'),
    unit('curriculum-ocr-reprocess-a-r2-monitor.service.d/alert-only.conf'),
    unit('curriculum-ocr-reprocess-a-r2-monitor-alert.conf.example'),
  ]);
  assert.match(monitor, /^EnvironmentFile=.*workspace-a-r2\/a1-anchors\.env$/mu);
  assert.match(monitor, /^ExecStartPre=\/usr\/bin\/sha256sum --check --strict .*workspace-a-r2\/SHA256SUMS$/mu);
  for (const variable of [
    'BDFZ_OCR_A1_IDENTITY_SHA256',
    'BDFZ_OCR_A1_RUN_STATUS_SHA256',
    'BDFZ_OCR_A1_STATE_HASHSET_SHA256',
    'BDFZ_OCR_A1_STATUS_HASHSET_SHA256',
    'BDFZ_OCR_A1_ARTIFACT_HASHSET_SHA256',
  ]) assert.match(monitor, new RegExp(`\\$\\{${variable}\\}`, 'u'));
  assert.match(monitor, /--inactive-worker-unit b-r3=curriculum-ocr-reprocess-b-r3\.service/u);
  assert.match(monitor, /--memory-min-gib 1/u);
  assert.match(timer, /^Persistent=true$/mu);
  assert.match(timer, /^OnUnitActiveSec=2min$/mu);
  assert.match(dropIn, /^OnFailure=curriculum-ocr-monitor-alert@%n\.service$/mu);
  assert.match(dropIn, /--mode observe/u);
  assert.match(alertConfig, /^BDFZ_OCR_ALERT_RUN_ROOT=\/home\/suen\/curriculum-ocr-offload\/runs\/20260716T1520Z-partial14-reprocess$/mu);
  assert.match(alertConfig, /^BDFZ_OCR_ALERT_LATEST_JSON=.*\/monitor-a-r2\/latest\.json$/mu);
  assert.match(alertConfig, /^BDFZ_OCR_ALERT_EXPECTED_RUN_ID=20260716T1520Z-partial14-reprocess$/mu);
  assert.match(alertConfig, /^BDFZ_OCR_ALERT_WORKER_UNIT=curriculum-ocr-reprocess-a-r2\.service$/mu);
  assert.match(alertConfig, /^BDFZ_OCR_ALERT_MONITOR_SCRIPT=.*\/workspace-a-r2\/scripts\/monitor-remote-ocr-single-shard\.mjs$/mu);
  assert.match(alertConfig, /^BDFZ_OCR_ALERT_MONITOR_SHA256=<LOWERCASE_64_HEX_SHA256>$/mu);
  assert.doesNotMatch(alertConfig, /(?:PASSWORD|TOKEN|COOKIE|\.secrets\.env)/iu);
});

test('shared completion cleanup reports a runtime-neutral fail-closed label', async () => {
  const source = await readFile(new URL('../scripts/cleanup-remote-ocr-completion.mjs', import.meta.url), 'utf8');
  assert.match(source, /Remote OCR completion cleanup failed closed:/u);
  assert.doesNotMatch(source, /B3 completion cleanup failed closed:/u);
});

test('A2 deployment runbook is executable, ordered, and preserves the authority boundary', async () => {
  const runbook = await readFile(new URL('../docs/remote-ocr-a2-deployment.md', import.meta.url), 'utf8');
  for (const exact of [
    'DMITPro2 inner bdfz workstation',
    'ssh dmitpro2',
    'ssh -p 22222 suen@localhost',
    'BatchMode=yes',
    'df -hT /',
    'free -h',
    'nvidia-smi',
    'systemctl --failed',
    'ss -lntup',
    'docker ps',
    'SHA256SUMS',
    'a1-anchors.env',
    'systemd-analyze --user verify',
    'provision-timeout-recovery-authority.mjs',
    'prepare-timeout-recovery-grant.mjs',
    '--seed-dry-run',
    '--seed-only',
    'curriculum-ocr-reprocess-a-r2-monitor.service',
    'curriculum-ocr-reprocess-a-r2-monitor.timer',
    'ActiveState',
    'MainPID',
    'ConditionResult',
    'NRestarts',
    'run-status.json.sha256',
    'archive',
    'readback',
    'freeze',
    'rollback',
  ]) assert.ok(runbook.includes(exact), exact);
  assert.match(runbook, /preview[^\n]*twice|two[^\n]*preview/iu);
  assert.match(runbook, /apply[^\n]*once|one[^\n]*apply/iu);
  assert.match(runbook, /irreversible|不可逆/iu);
  assert.match(runbook, /must not.*restore|不得.*恢复/iu);
  assert.doesNotMatch(runbook, /(?:PASSWORD|TOKEN|COOKIE|API_KEY)\s*[=:]\s*[^<\s]/iu);
});

test('A2 source materialization rejects AppleDouble and every unlisted regular file', async () => {
  const runbook = await readFile(new URL('../docs/remote-ocr-a2-deployment.md', import.meta.url), 'utf8');
  const step2 = runbook.slice(
    runbook.indexOf('## 2. Materialize the exact reviewed Git tree'),
    runbook.indexOf('## 3. Authority and grant'),
  );
  assert.match(step2, /export COPYFILE_DISABLE=1/u);
  assert.match(step2, /MAC_TAR=\(tar --no-mac-metadata --no-xattrs\)/u);
  assert.match(step2, /"\$\{MAC_TAR\[@\]\}" -xf - -C "\$LOCAL_STAGE"/u);
  assert.match(step2, /"\$\{MAC_TAR\[@\]\}" -C "\$LOCAL_STAGE" -cf "\$LOCAL_TAR" \./u);
  assert.match(step2, /tar -tf "\$LOCAL_TAR"[\s\S]*\(\^\|\/\)\\\._/u);
  assert.doesNotMatch(step2, /"\$\{MAC_TAR\[@\]\}" -tf/u);
  const remoteMaterialization = step2.slice(step2.indexOf('EXPECTED_TAR_SHA=$2'));
  assert.match(remoteMaterialization, /tar -xf "\$REMOTE_UPLOAD" -C/u);
  assert.doesNotMatch(remoteMaterialization, /tar --no-mac-metadata|tar --no-xattrs/u);

  const noAppleDouble = step2.match(/^[ \t]*assert_no_appledouble\(\) \{\n[\s\S]*?^[ \t]*\}/mu)?.[0];
  const exactTree = step2.match(/^[ \t]*assert_exact_source_tree\(\) \{\n[\s\S]*?^[ \t]*\}/mu)?.[0];
  assert.ok(noAppleDouble, 'assert_no_appledouble function');
  assert.ok(exactTree, 'assert_exact_source_tree function');
  assert.match(noAppleDouble, /-name '\._\*'/u);
  assert.match(exactTree, /cmp SOURCE_SHA256SUMS/u);

  const probe = spawnSync('/bin/bash', ['-se'], {
    encoding: 'utf8',
    input: `set -euo pipefail
${noAppleDouble}
${exactTree}
ROOT=$(mktemp -d)
ACTUAL=$(mktemp)
trap 'rm -rf "$ROOT" "$ACTUAL"' EXIT INT TERM
printf '%s\\n' payload > "$ROOT/payload.txt"
(
  cd "$ROOT"
  find . -type f ! -name SOURCE_SHA256SUMS -print0 \
    | LC_ALL=C sort -z | xargs -0 sha256sum > SOURCE_SHA256SUMS
)
assert_no_appledouble "$ROOT"
assert_exact_source_tree "$ROOT" "$ACTUAL"
printf '%s\\n' AppleDouble > "$ROOT/._payload.txt"
if assert_no_appledouble "$ROOT"; then exit 91; fi
rm "$ROOT/._payload.txt"
printf '%s\\n' unlisted > "$ROOT/unexpected.txt"
if assert_exact_source_tree "$ROOT" "$ACTUAL"; then exit 92; fi
`,
  });
  assert.equal(probe.status, 0, probe.stderr);
});

test('A2 workspace and anchor evidence is created with a real noclobber failure', async () => {
  const runbook = await readFile(new URL('../docs/remote-ocr-a2-deployment.md', import.meta.url), 'utf8');
  const step4 = runbook.slice(
    runbook.indexOf('## 4. Compute `a1-anchors.env`'),
    runbook.indexOf('## 4A. Forward repair'),
  );
  const noclobber = step4.match(/^write_noclobber_stdin\(\) \{\n[\s\S]*?^\}/mu)?.[0];
  assert.ok(noclobber, 'write_noclobber_stdin function');
  for (const exact of [
    'WORKSPACE_SEAL_EVIDENCE="$EVIDENCE/workspace-SHA256SUMS.sha256"',
    'ANCHOR_EVIDENCE="$EVIDENCE/a1-anchors.env"',
    'ANCHOR_SEAL_EVIDENCE="$EVIDENCE/a1-anchors.env.sha256"',
    'test ! -e "$evidence_path"',
    'test ! -L "$evidence_path"',
    'write_noclobber_stdin "$WORKSPACE_SEAL_EVIDENCE"',
    'write_noclobber_stdin "$ANCHOR_EVIDENCE"',
    'write_noclobber_stdin "$ANCHOR_SEAL_EVIDENCE"',
  ]) assert.ok(step4.includes(exact), exact);

  const probe = spawnSync('/bin/bash', ['-se'], {
    encoding: 'utf8',
    input: `set -euo pipefail
${noclobber}
TARGET=$(mktemp -u)
trap 'rm -f "$TARGET"' EXIT INT TERM
printf '%s\\n' first | write_noclobber_stdin "$TARGET"
if printf '%s\\n' second | write_noclobber_stdin "$TARGET"; then exit 93; fi
test "$(cat "$TARGET")" = first
`,
  });
  assert.equal(probe.status, 0, probe.stderr);
});

test('A2 pre-claim AppleDouble repair preserves evidence and never reapplies the grant', async () => {
  const runbook = await readFile(new URL('../docs/remote-ocr-a2-deployment.md', import.meta.url), 'utf8');
  const repair = runbook.slice(
    runbook.indexOf('## 4A. Forward repair'),
    runbook.indexOf('## 5. Create the exact successor inode'),
  );
  assert.ok(repair.length > 0, 'forward repair section');
  for (const exact of [
    'd4360775194aaf8593a9fa5db10cf7465b222534',
    'QUARANTINED_WORKSPACE="$INCIDENT/workspace-a-r2-contaminated"',
    'mv -T "$WORKSPACE" "$QUARANTINED_WORKSPACE"',
    'test "$WORKSPACE_DEVICE_BEFORE" = "$WORKSPACE_DEVICE_AFTER"',
    'test "$WORKSPACE_INODE_BEFORE" = "$WORKSPACE_INODE_AFTER"',
    'AUTHORITY_CLAIM_COUNT=',
    'test "$AUTHORITY_CLAIM_COUNT" -eq 0',
    'test ! -e "$A2"',
    'test ! -e "$MONITOR_DIR"',
    'test ! -e "$LOCK"',
    'cmp "$QUARANTINED_WORKSPACE/SOURCE_SHA256SUMS" "$WORKSPACE/SOURCE_SHA256SUMS"',
    'cmp "$EVIDENCE/a1-anchors.env" "$ANCHORS"',
    'verified_idempotent',
    'FORWARD_REPAIR_SHA256SUMS',
    'write_noclobber_stdin "$INCIDENT/FORWARD_REPAIR_SHA256SUMS"',
    'REPAIR_PROTOCOL_COMMIT="<REVIEWED_A2_FORWARD_REPAIR_COMMIT>"',
    'git -C "$REPO" status --porcelain=v1 --untracked-files=all',
    "--abbrev-ref --symbolic-full-name '@{upstream}'",
    'REPAIR_PROTOCOL_COMMIT=$1',
    'REPAIR_RUNBOOK_BLOB=$2',
    'REPAIR_TEST_BLOB=$3',
    '"${REPAIR_PROTOCOL_COMMIT}:docs/remote-ocr-a2-deployment.md"',
    '"${REPAIR_PROTOCOL_COMMIT}:tests/remote-ocr-a2-systemd.test.mjs"',
    'test "$REPAIR_PROTOCOL_COMMIT" != "$EXPECTED_COMMIT"',
    'write_noclobber_stdin "$INCIDENT/repair-protocol.env"',
    'repair_protocol_commit=',
    'runbook_blob=',
    'test_blob=',
  ]) assert.ok(repair.includes(exact), exact);
  assert.doesNotMatch(repair, /rm\s+(?:-[^\s]+\s+)*"?\$WORKSPACE/u);
  const code = [...repair.matchAll(/```(?:zsh|bash)\n([\s\S]*?)```/gu)]
    .map((match) => match[1])
    .join('\n');
  assert.doesNotMatch(code, /--apply/u);
  assert.doesNotMatch(code, /--seed-(?:dry-run|only)/u);
  assert.equal(
    (code.match(/scripts\/prepare-timeout-recovery-grant\.mjs/gu) || []).length,
    2,
  );
  assert.match(code, /grant-repair-preview-1\.json[\s\S]*grant-repair-preview-2\.json[\s\S]*cmp/u);
});

test('A2 partial AppleDouble incident resumes through a quiet two-phase state machine', async () => {
  const [runbook, resumeScript] = await Promise.all([
    readFile(new URL('../docs/remote-ocr-a2-deployment.md', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/resume-a2-appledouble-quarantine.sh', import.meta.url), 'utf8'),
  ]);
  const resume = runbook.slice(
    runbook.indexOf('## 4B. Resume the partial pre-move incident'),
    runbook.indexOf('## 4C. Revalidate the repaired workspace'),
  );
  assert.ok(resume.length > 0, 'partial-resume section');
  for (const exact of [
    'scripts/resume-a2-appledouble-quarantine.sh',
    'REPAIR_PROTOCOL_REPO=',
    'RESUME_SCRIPT_BLOB=',
    'inspect',
    'seal',
    'PREMOVE_READY',
    'MOVED_UNSEALED',
    'SEALED',
    'Never retry `seal` after an unknown SSH result',
    'd4360775194aaf8593a9fa5db10cf7465b222534',
    '38f2e5bce7d7782163619782a8ce181cb40417b6',
  ]) assert.ok(resume.includes(exact), exact);
  assert.equal((resume.match(/"\$\{SSH_INNER\[@\]\}" bash -se/gu) || []).length, 2);
  assert.doesNotMatch(resume, /--apply|--seed-(?:dry-run|only)/u);
  assert.doesNotMatch(resume, /rm\s+(?:-[^\s]+\s+)*"?\$(?:WORKSPACE|INCIDENT|AUTHORITY|GRANT)/u);

  for (const exact of [
    '/usr/bin/sudo -n /usr/bin/mv -T --no-clobber --no-copy --',
    '"$WORKSPACE" "$QUARANTINED_WORKSPACE"',
    'incident and workspace are not on the same filesystem',
    'EXPECTED_EVIDENCE_INODE=41854492',
    'EXPECTED_INCIDENT_INODE=43669283',
    'EXPECTED_AUTHORITY_INODE=41854486',
    'incident filesystem changed immediately before move',
    'workspace final manifest does not cover the exact file tree',
    'workspace contains an empty or unexpected directory',
    'classify_state',
    'assert_exact_regular_file',
    'assert_exact_incident_top_level',
    'assert_exact_authority_top_level',
    'assert_partial_seal_evidence',
    'assert_post_move_prefix',
    'assert_canonical_sha256_sidecar',
    'assert_deterministic_preview',
    'EXPECTED_AUTHORITY_PREVIEW_SHA256=0e12e99619af4207aa8f21fc8f0c8ac75826a20f5f347bd67908b0336e1f02f9',
    'EXPECTED_GRANT_PREVIEW_SHA256=8ac1ea3624f911b3088ddadc719d340f6c72cebd453f3f4758426adb539308d1',
    'sha256_value "$active_workspace/SHA256SUMS"',
    'BDFZ_A2_ATOMIC_PARENT_NLINK=$expected_parent_nlink',
    'os.O_TMPFILE',
    'os.open(\n        b"."',
    'os.fsync(fd)',
    'procfd = f"/proc/self/fd/{fd}"',
    'linkat(-100, ctypes.c_char_p(procfd), dirfd, ctypes.c_char_p(name), 0x400)',
    'BDFZ_A2_ATOMIC_PAYLOAD=$payload',
    '__A2_GENERATOR_COMPLETE_d4360775194aaf8593a9fa5db10cf7465b222534__',
    'GNU mv lacks --no-copy',
    'non-interactive sudo is unavailable',
    'probe_target_otmpfile 2',
    'probe_target_otmpfile 3',
    'target filesystem lacks safe O_TMPFILE support',
    'sha256sum --check --strict --status',
    'resume-protocol.env',
    'workspace-stat-after.env',
    'QUARANTINE_EVIDENCE_SHA256SUMS',
    'QUARANTINE_EVIDENCE_SHA256SUMS.sha256',
    'AUTHORITY_CLAIM_COUNT',
    'test "$AUTHORITY_CLAIM_COUNT" -eq 0',
    'systemctl --user show',
  ]) assert.ok(resumeScript.includes(exact), exact);
  assert.doesNotMatch(resumeScript, /sha256sum --check --strict(?! --status)/u);
  assert.doesNotMatch(resumeScript, /mv -T "\$WORKSPACE"/u);
  assert.doesNotMatch(resumeScript, /mv -T --no-clobber -- "\$WORKSPACE"/u);
  assert.doesNotMatch(resumeScript, /linkat\(fd, ctypes\.c_char_p\(b""\)/u);
  assert.doesNotMatch(resumeScript, /0x1000/u);
  assert.doesNotMatch(resumeScript, /cat > "\$pathname"/u);
  assert.doesNotMatch(resumeScript, /\|\s*(?:atomic_noclobber_bytes|publish_generator_noclobber)/u);
  assert.doesNotMatch(resumeScript, /sha256sum --check[^\n]*workspace-SHA256SUMS\.sha256/u);
  assert.doesNotMatch(resumeScript, /--apply|--seed-(?:dry-run|only)/u);
  assert.doesNotMatch(resumeScript, /rm\s+(?:-[^\s]+\s+)*"?\$(?:WORKSPACE|INCIDENT|AUTHORITY|GRANT)/u);
  assert.ok(
    resumeScript.indexOf('probe_target_otmpfile 2')
      < resumeScript.indexOf('/usr/bin/sudo -n /usr/bin/mv -T --no-clobber --no-copy'),
    'target filesystem O_TMPFILE probe must precede the move',
  );
  assert.equal(spawnSync('/bin/bash', ['-n'], { input: resumeScript }).status, 0);
});

test('A2 partial-resume helpers reject ambiguous, altered, linked, and extra evidence', async () => {
  const resumeScript = await readFile(
    new URL('../scripts/resume-a2-appledouble-quarantine.sh', import.meta.url),
    'utf8',
  );
  const fixture = spawnSync('/bin/bash', ['-se'], {
    encoding: 'utf8',
    env: { ...process.env, RESUME_SCRIPT_SOURCE: resumeScript },
    input: `set -euo pipefail
BDFZ_A2_RESUME_LIBRARY_ONLY=1
eval "$RESUME_SCRIPT_SOURCE"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT INT TERM
WORKSPACE="$ROOT/workspace"
QUARANTINED="$ROOT/quarantined"
mkdir "$WORKSPACE"
DEVICE=$(stat_value %d "$WORKSPACE")
INODE=$(stat_value %i "$WORKSPACE")
test "$(classify_state "$WORKSPACE" "$QUARANTINED" "$DEVICE" "$INODE")" = PREMOVE_READY
mv "$WORKSPACE" "$QUARANTINED"
test "$(classify_state "$WORKSPACE" "$QUARANTINED" "$DEVICE" "$INODE")" = MOVED_UNSEALED
: > "$QUARANTINED/../resume-protocol.env"
test "$(classify_state "$WORKSPACE" "$QUARANTINED" "$DEVICE" "$INODE" "$QUARANTINED/..")" = MOVED_UNSEALED
for name in workspace-stat-after.env QUARANTINE_EVIDENCE_SHA256SUMS QUARANTINE_EVIDENCE_SHA256SUMS.sha256; do
  : > "$QUARANTINED/../$name"
done
test "$(classify_state "$WORKSPACE" "$QUARANTINED" "$DEVICE" "$INODE" "$QUARANTINED/..")" = SEALED
mkdir "$WORKSPACE"
if (BDFZ_A2_RESUME_LIBRARY_ONLY=0; classify_state "$WORKSPACE" "$QUARANTINED" "$DEVICE" "$INODE" "$QUARANTINED/..") >/dev/null 2>&1; then exit 91; fi
rmdir "$WORKSPACE"
if (BDFZ_A2_RESUME_LIBRARY_ONLY=0; classify_state "$WORKSPACE" "$QUARANTINED" "$DEVICE" "$((INODE + 1))" "$QUARANTINED/..") >/dev/null 2>&1; then exit 92; fi

FILE="$ROOT/evidence"
printf '%s' exact > "$FILE"
SHA=$(sha256sum "$FILE" | awk '{print $1}')
SIZE=$(stat_value %s "$FILE")
assert_exact_regular_file "$FILE" 600 "$(id -u)" 1 "$SIZE" "$SHA"
printf '%s' changed > "$FILE"
if (BDFZ_A2_RESUME_LIBRARY_ONLY=0; assert_exact_regular_file "$FILE" 600 "$(id -u)" 1 "$SIZE" "$SHA") >/dev/null 2>&1; then exit 93; fi
rm "$FILE"
printf '%s' exact > "$ROOT/target"
ln -s "$ROOT/target" "$FILE"
if (BDFZ_A2_RESUME_LIBRARY_ONLY=0; assert_exact_regular_file "$FILE" 777 "$(id -u)" 1 5 "$SHA") >/dev/null 2>&1; then exit 94; fi

INCIDENT="$ROOT/incident"
mkdir "$INCIDENT"
for name in incident.env repair-protocol.env appledouble-files.txt appledouble-files.SHA256SUMS contaminated-workspace-seals.sha256 workspace-stat-before.env; do
  : > "$INCIDENT/$name"
done
assert_exact_incident_top_level "$INCIDENT"
: > "$INCIDENT/extra"
if (BDFZ_A2_RESUME_LIBRARY_ONLY=0; assert_exact_incident_top_level "$INCIDENT") >/dev/null 2>&1; then exit 95; fi
`,
  });
  assert.equal(fixture.status, 0, fixture.stderr);
});

test('A2 atomic evidence publication is no-replace and never exposes a failed payload', {
  skip: process.platform !== 'linux',
}, async () => {
  const resumeScript = await readFile(
    new URL('../scripts/resume-a2-appledouble-quarantine.sh', import.meta.url),
    'utf8',
  );
  const fixture = spawnSync('/bin/bash', ['-se'], {
    encoding: 'utf8',
    env: { ...process.env, RESUME_SCRIPT_SOURCE: resumeScript },
    input: `set -euo pipefail
BDFZ_A2_RESUME_LIBRARY_ONLY=1
eval "$RESUME_SCRIPT_SOURCE"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT INT TERM
chmod 700 "$ROOT"
DEVICE=$(stat -c %d "$ROOT")
INODE=$(stat -c %i "$ROOT")
CURRENT_UID=$(id -u)
CURRENT_GID=$(id -g)

PAYLOAD=$'complete payload\n'
atomic_noclobber_bytes "$ROOT/direct" "$PAYLOAD" \
  "$DEVICE" "$INODE" "$CURRENT_UID" "$CURRENT_GID" 700 2
cmp -s "$ROOT/direct" <(printf '%s' "$PAYLOAD")
if atomic_noclobber_bytes "$ROOT/direct" replacement \
  "$DEVICE" "$INODE" "$CURRENT_UID" "$CURRENT_GID" 700 2 >/dev/null 2>&1; then exit 91; fi
cmp -s "$ROOT/direct" <(printf '%s' "$PAYLOAD")

if atomic_noclobber_bytes "$ROOT/injected-failure" partial \
  "$DEVICE" "$INODE" "$CURRENT_UID" "$CURRENT_GID" 700 2 1 >/dev/null 2>&1; then exit 92; fi
test ! -e "$ROOT/injected-failure"
test ! -L "$ROOT/injected-failure"

good_generator() { printf 'generated payload\n'; }
failed_generator() { printf 'partial payload'; return 73; }
publish_generator_noclobber "$ROOT/generated" good_generator \
  "$DEVICE" "$INODE" "$CURRENT_UID" "$CURRENT_GID" 700 2
cmp -s "$ROOT/generated" <(printf 'generated payload\n')
if publish_generator_noclobber "$ROOT/failed-generator" failed_generator \
  "$DEVICE" "$INODE" "$CURRENT_UID" "$CURRENT_GID" 700 2 >/dev/null 2>&1; then exit 93; fi
test ! -e "$ROOT/failed-generator"

INCIDENT_FIXTURE="$ROOT/incident"
QUARANTINED_FIXTURE="$INCIDENT_FIXTURE/workspace-a-r2-contaminated"
ORIGINAL_FIXTURE="$ROOT/workspace-a-r2"
mkdir "$INCIDENT_FIXTURE" "$ORIGINAL_FIXTURE"
MOVE_COMMAND=(/usr/bin/mv)
if test "$(command -v sudo || true)" = /usr/bin/sudo \
  && /usr/bin/sudo -n /usr/bin/true >/dev/null 2>&1; then
  chmod 500 "$ORIGINAL_FIXTURE"
  MOVE_COMMAND=(/usr/bin/sudo -n /usr/bin/mv)
fi
FIXTURE_DEVICE=$(stat -c %d "$ORIGINAL_FIXTURE")
FIXTURE_INODE=$(stat -c %i "$ORIGINAL_FIXTURE")
INCIDENT_INODE=$(stat -c %i "$INCIDENT_FIXTURE")
test "$(classify_state "$ORIGINAL_FIXTURE" "$QUARANTINED_FIXTURE" \
  "$FIXTURE_DEVICE" "$FIXTURE_INODE" "$INCIDENT_FIXTURE")" = PREMOVE_READY
"\${MOVE_COMMAND[@]}" -T --no-clobber --no-copy -- "$ORIGINAL_FIXTURE" "$QUARANTINED_FIXTURE"
test "$(classify_state "$ORIGINAL_FIXTURE" "$QUARANTINED_FIXTURE" \
  "$FIXTURE_DEVICE" "$FIXTURE_INODE" "$INCIDENT_FIXTURE")" = MOVED_UNSEALED
marker_generator() { printf 'sealed marker\n'; }
for marker in \
  resume-protocol.env \
  workspace-stat-after.env \
  QUARANTINE_EVIDENCE_SHA256SUMS; do
  if atomic_noclobber_bytes "$INCIDENT_FIXTURE/$marker" incomplete \
    "$FIXTURE_DEVICE" "$INCIDENT_INODE" "$CURRENT_UID" "$CURRENT_GID" 700 3 1 \
    >/dev/null 2>&1; then exit 94; fi
  test ! -e "$INCIDENT_FIXTURE/$marker"
  publish_generator_noclobber "$INCIDENT_FIXTURE/$marker" marker_generator \
    "$FIXTURE_DEVICE" "$INCIDENT_INODE" "$CURRENT_UID" "$CURRENT_GID" 700 3
  test "$(classify_state "$ORIGINAL_FIXTURE" "$QUARANTINED_FIXTURE" \
    "$FIXTURE_DEVICE" "$FIXTURE_INODE" "$INCIDENT_FIXTURE")" = MOVED_UNSEALED
done
if atomic_noclobber_bytes \
  "$INCIDENT_FIXTURE/QUARANTINE_EVIDENCE_SHA256SUMS.sha256" incomplete \
  "$FIXTURE_DEVICE" "$INCIDENT_INODE" "$CURRENT_UID" "$CURRENT_GID" 700 3 1 \
  >/dev/null 2>&1; then exit 95; fi
test ! -e "$INCIDENT_FIXTURE/QUARANTINE_EVIDENCE_SHA256SUMS.sha256"
publish_generator_noclobber \
  "$INCIDENT_FIXTURE/QUARANTINE_EVIDENCE_SHA256SUMS.sha256" marker_generator \
  "$FIXTURE_DEVICE" "$INCIDENT_INODE" "$CURRENT_UID" "$CURRENT_GID" 700 3
test "$(classify_state "$ORIGINAL_FIXTURE" "$QUARANTINED_FIXTURE" \
  "$FIXTURE_DEVICE" "$FIXTURE_INODE" "$INCIDENT_FIXTURE")" = SEALED
`,
  });
  assert.equal(fixture.status, 0, fixture.stderr);
});

test('A2 deployment creates a new private monitor output directory before worker start', async () => {
  const runbook = await readFile(new URL('../docs/remote-ocr-a2-deployment.md', import.meta.url), 'utf8');
  for (const exact of [
    'MONITOR_DIR="$RUN_ROOT/monitor-a-r2"',
    'test ! -e "$MONITOR_DIR"',
    'test ! -L "$MONITOR_DIR"',
    'mkdir -m 700 "$MONITOR_DIR"',
    'test -d "$MONITOR_DIR"',
    'test "$(stat -c %a "$MONITOR_DIR")" = 700',
    'test "$(stat -c %u "$MONITOR_DIR")" = "$(id -u)"',
  ]) assert.ok(runbook.includes(exact), exact);
  const createAt = runbook.indexOf('mkdir -m 700 "$MONITOR_DIR"');
  const workerStartAt = runbook.indexOf('systemctl --user start curriculum-ocr-reprocess-a-r2.service');
  assert.ok(createAt >= 0 && workerStartAt >= 0 && createAt < workerStartAt);
});

test('A2 deployment binds the exact reviewed alert handler and retry chain', async () => {
  const runbook = await readFile(new URL('../docs/remote-ocr-a2-deployment.md', import.meta.url), 'utf8');
  for (const exact of [
    'scripts/notify-remote-ocr-single-shard-monitor.mjs',
    'ops/systemd/curriculum-ocr-monitor-alert@.service',
    'ops/systemd/curriculum-ocr-monitor-alert-retry@.timer',
    '"$HOME/.config/systemd/user/curriculum-ocr-monitor-alert@.service"',
    '"$HOME/.config/systemd/user/curriculum-ocr-monitor-alert-retry@.timer"',
    '"$HOME/curriculum-ocr-offload/alert-runtime/notify-remote-ocr-single-shard-monitor.mjs"',
    '"$HOME/curriculum-ocr-offload/alert-runtime/SHA256SUMS"',
    '"$SYSTEMD_USER/curriculum-ocr-monitor-alert@.service"',
    '"$SYSTEMD_USER/curriculum-ocr-monitor-alert-retry@.timer"',
    'cmp "$WORKSPACE/scripts/notify-remote-ocr-single-shard-monitor.mjs"',
    'cmp "$WORKSPACE/ops/systemd/curriculum-ocr-monitor-alert@.service"',
    'cmp "$WORKSPACE/ops/systemd/curriculum-ocr-monitor-alert-retry@.timer"',
    'ALERT_RUNTIME="$HOME/curriculum-ocr-offload/alert-runtime"',
    'alert-runtime-state.env',
  ]) assert.ok(runbook.includes(exact), exact);
  assert.match(runbook, /sha256sum "\$ALERT_RUNTIME\/notify-remote-ocr-single-shard-monitor\.mjs"[\s\S]*SHA256SUMS/u);
  const archiveBlock = runbook.slice(
    runbook.indexOf('git -C "$REPO" archive'),
    runbook.indexOf('| "${MAC_TAR[@]}" -xf - -C "$LOCAL_STAGE"'),
  );
  for (const exact of [
    'scripts/notify-remote-ocr-single-shard-monitor.mjs',
    'ops/systemd/curriculum-ocr-monitor-alert@.service',
    'ops/systemd/curriculum-ocr-monitor-alert-retry@.timer',
  ]) assert.ok(archiveBlock.includes(exact), exact);
  const verifyBlock = runbook.slice(
    runbook.indexOf('systemd-analyze --user verify'),
    runbook.indexOf('! systemctl --user cat curriculum-ocr-reprocess-a-r2.service'),
  );
  assert.ok(verifyBlock.includes('"$SYSTEMD_USER/curriculum-ocr-monitor-alert@.service"'));
  assert.ok(verifyBlock.includes('"$SYSTEMD_USER/curriculum-ocr-monitor-alert-retry@.timer"'));
  const rollbackBlock = runbook.slice(runbook.indexOf('## 11. Rollback and irreversible boundary'));
  assert.ok(rollbackBlock.includes('ALERT_RUNTIME_STATE='));
  assert.ok(rollbackBlock.includes('alert-runtime-state.env'));
  assert.ok(rollbackBlock.includes('sha256sum --check --strict SHA256SUMS'));
  const disableOldAt = runbook.indexOf('systemctl --user disable --now curriculum-ocr-reprocess-b-r3-monitor.timer');
  const installHandlerAt = runbook.indexOf('install -m 0644 "$WORKSPACE/ops/systemd/curriculum-ocr-monitor-alert@.service"');
  assert.ok(disableOldAt >= 0 && installHandlerAt >= 0 && disableOldAt < installHandlerAt);
});

test('A2 rollback proves every runtime is quiescent before restoring shared files', async () => {
  const runbook = await readFile(new URL('../docs/remote-ocr-a2-deployment.md', import.meta.url), 'utf8');
  const rollback = runbook.slice(runbook.indexOf('## 11. Rollback and irreversible boundary'));
  assert.doesNotMatch(rollback, /\|\|\s*(?:true|:)/u);
  assert.doesNotMatch(rollback, /set \+e/u);
  for (const exact of [
    'reviewed_unit_absent()',
    'disable_timer_or_reviewed_absent()',
    'disable_worker_or_reviewed_absent()',
    'stop_service_or_reviewed_absent()',
    'assert_service_quiet_or_reviewed_absent()',
    'LoadState --value',
    'not-found)',
    'test "$ACTIVE_STATE" = inactive',
    'test "$MAIN_PID" = 0',
    'test "$ENABLED_STATE" = disabled',
    'curriculum-ocr-reprocess-a-r2-monitor.timer',
    'curriculum-ocr-monitor-alert-retry@curriculum-ocr-reprocess-a-r2-monitor.service.timer',
    'curriculum-ocr-reprocess-a-r2.service',
    'curriculum-ocr-reprocess-a-r2-monitor.service',
    'curriculum-ocr-monitor-alert@curriculum-ocr-reprocess-a-r2-monitor.service.service',
    'curriculum-ocr-reprocess-a-r2-cleanup.service',
    'curriculum-ocr-llama.service',
    'disable_timer_or_reviewed_absent "$MONITOR_TIMER"',
    'disable_timer_or_reviewed_absent "$ALERT_RETRY_TIMER"',
    'disable_worker_or_reviewed_absent "$WORKER"',
    'stop_service_or_reviewed_absent "$MONITOR"',
    'stop_service_or_reviewed_absent "$ALERT_HANDLER"',
    'stop_service_or_reviewed_absent "$CLEANUP"',
    'stop_service_or_reviewed_absent "$LLAMA"',
    'assert_timer_quiet_or_reviewed_absent "$MONITOR_TIMER"',
    'assert_timer_quiet_or_reviewed_absent "$ALERT_RETRY_TIMER"',
    'assert_worker_quiet_or_reviewed_absent "$WORKER"',
    'assert_service_quiet_or_reviewed_absent "$MONITOR"',
    'assert_service_quiet_or_reviewed_absent "$ALERT_HANDLER"',
    'assert_service_quiet_or_reviewed_absent "$CLEANUP"',
    'assert_service_quiet_or_reviewed_absent "$LLAMA"',
    'QUIESCENCE_VERIFIED=1',
    'test "$QUIESCENCE_VERIFIED" = 1',
  ]) assert.ok(rollback.includes(exact), exact);
  assert.match(rollback, /not-found[\s\S]*file-state\.tsv[\s\S]*test ! -e[\s\S]*test ! -L/u);
  const quiescenceAt = rollback.indexOf('QUIESCENCE_VERIFIED=1');
  const restoreAt = rollback.indexOf("while IFS=$'\\t' read -r state relative; do");
  const daemonReloadAt = rollback.indexOf('systemctl --user daemon-reload');
  assert.ok(quiescenceAt >= 0 && restoreAt > quiescenceAt && daemonReloadAt > restoreAt);
  for (const unit of [
    'curriculum-ocr-reprocess-a-r2-monitor.timer',
    'curriculum-ocr-monitor-alert-retry@curriculum-ocr-reprocess-a-r2-monitor.service.timer',
    'curriculum-ocr-reprocess-a-r2.service',
    'curriculum-ocr-reprocess-a-r2-monitor.service',
    'curriculum-ocr-monitor-alert@curriculum-ocr-reprocess-a-r2-monitor.service.service',
    'curriculum-ocr-reprocess-a-r2-cleanup.service',
    'curriculum-ocr-llama.service',
  ]) assert.ok(rollback.indexOf(unit) < quiescenceAt, unit);
  assert.match(rollback, /successor, monitor evidence directory, alert[\s\S]*remain preserved/iu);
});

test('A2 rollback timer assertions do not query the service-only MainPID property', async () => {
  const runbook = await readFile(new URL('../docs/remote-ocr-a2-deployment.md', import.meta.url), 'utf8');
  const rollback = runbook.slice(runbook.indexOf('## 11. Rollback and irreversible boundary'));
  const timerFunction = rollback.match(/^assert_timer_inactive\(\) \{\n[\s\S]*?^\}/mu)?.[0];
  const processFunction = rollback.match(/^assert_process_unit_inactive\(\) \{\n[\s\S]*?^\}/mu)?.[0];
  assert.ok(timerFunction, 'assert_timer_inactive function');
  assert.ok(processFunction, 'assert_process_unit_inactive function');
  assert.match(timerFunction, /ActiveState/u);
  assert.doesNotMatch(timerFunction, /MainPID/u);
  assert.match(processFunction, /ActiveState/u);
  assert.match(processFunction, /MainPID/u);
  const timerDisableFunction = rollback.match(/^disable_timer_or_reviewed_absent\(\) \{\n[\s\S]*?^\}/mu)?.[0];
  const timerReproofFunction = rollback.match(/^assert_timer_quiet_or_reviewed_absent\(\) \{\n[\s\S]*?^\}/mu)?.[0];
  assert.match(timerDisableFunction, /assert_timer_inactive/u);
  assert.doesNotMatch(timerDisableFunction, /assert_process_unit_inactive/u);
  assert.match(timerReproofFunction, /assert_timer_inactive/u);
  assert.doesNotMatch(timerReproofFunction, /assert_process_unit_inactive/u);
  for (const name of [
    'disable_worker_or_reviewed_absent',
    'stop_service_or_reviewed_absent',
    'assert_worker_quiet_or_reviewed_absent',
    'assert_service_quiet_or_reviewed_absent',
  ]) {
    const body = rollback.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'mu'))?.[0];
    assert.match(body, /assert_process_unit_inactive/u, name);
    assert.doesNotMatch(body, /assert_timer_inactive/u, name);
  }
  assert.doesNotMatch(rollback, /^assert_inactive\(\)/mu);

  const probe = spawnSync('/bin/bash', ['-se'], {
    encoding: 'utf8',
    input: `set -euo pipefail
systemctl() {
  case "$*" in
    *"--property=ActiveState --value") printf '%s\\n' inactive ;;
    *"--property=MainPID --value") return 97 ;;
    *) return 98 ;;
  esac
}
${timerFunction}
assert_timer_inactive fixture.timer
`,
  });
  assert.equal(probe.status, 0, probe.stderr);
});
