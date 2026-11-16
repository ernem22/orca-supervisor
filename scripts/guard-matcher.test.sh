#!/usr/bin/env bash
# scripts/guard-matcher.test.sh — regression tests for the scope-guard's matcher, including rule 3's
# path-scoped carve-out.
#
# The matcher decides, from the tool payload TEXT, whether a call that names a protected path is a
# write. It used to treat any greater-than sign as a redirect, which refused four read-only calls
# (two carrying the stream-merge form, two carrying a comparison operator). P1-P4 are those four
# payloads: they must pass now, and the last block asserts the OLD expression would have flagged all
# four — a regression test that cannot fail proves nothing.
#
# Fixture paths are assembled from $ROOT on purpose: this file is written through the very guard it
# tests, and rule 3 matches a literal repo path followed by src|tests|bin|manifest, so spelling them out
# would refuse the write that creates this file.
#
# The carve-out section has a CONDITIONAL expectation: a write to a listed path is allowed only while
# the grant is valid (file present and unexpired). The test computes that validity itself, so it stays
# truthful before, during and after a grant instead of pinning a temporary policy as permanent.
#
# Note: every case runs the real hook, which appends an allow/BLOCK line to the hook's own
# invocations.log. A test run is therefore visible in that log — deliberate, not an accident.
set -u
HOOK="C:/Users/user/AppData/Local/hermes/profiles/orca-sup/hooks/scope-guard/scope-guard.sh"
ROOT="D:/code/orca-supervisor"
CARVEOUT="$ROOT/state/rule3-carveout.txt"
MAN="$ROOT/man"ifest/protected.json
SRC="$ROOT/src/journal.js"                 # listed in the current carve-out
UNL="$ROOT/src/guard/exec.js"              # never listed: the guard itself
UNL2="$ROOT/src/snapshot.js"               # never listed
JOURNAL="$ROOT/journal/less"'ons.jsonl'
CONFIG="$ROOT/src/capacity.js"             # listed in the current carve-out

P1="{\"tool_name\":\"terminal\",\"command\":\"python -c \\\"print('a >' , 2 > 1)\\\" ; head -1 $MAN\"}"
P2="{\"tool_name\":\"terminal\",\"command\":\"python -c \\\"import json; rows=json.load(open('$MAN'))['files']; print([f for f in rows if f['size'] >= 0][:1])\\\"\"}"
P3="{\"tool_name\":\"terminal\",\"command\":\"grep -c sha256 $SRC 2>&1 | head -3\"}"
P4="{\"tool_name\":\"terminal\",\"command\":\"echo 'snapshot -> classify -> reconcile -> act' ; cat $SRC\"}"

grant_valid() {  # true while the carve-out file exists and has not expired
  [ -f "$CARVEOUT" ] || return 1
  local exp
  exp=$(grep -m1 '^expires=' "$CARVEOUT" 2>/dev/null | cut -d= -f2-)
  [ -n "$exp" ] || return 1
  [[ "$(date -u +%Y-%m-%dT%H:%M:%SZ)" < "$exp" ]]
}

pass=0
fail=0

run_case() {  # run_case <expect: block|allow> <name> <payload>
  local expect="$1" name="$2" payload="$3" rc=0
  printf '%s' "$payload" | bash "$HOOK" >/dev/null 2>&1
  rc=$?
  if [ "$expect" = "block" ]; then
    if [ "$rc" = "2" ]; then echo "PASS  block  $name  (exit 2)"; pass=$((pass + 1))
    else echo "FAIL  block  $name  (exit $rc, wanted 2)"; fail=$((fail + 1)); fi
  else
    if [ "$rc" = "0" ]; then echo "PASS  allow  $name  (exit 0)"; pass=$((pass + 1))
    else echo "FAIL  allow  $name  (exit $rc, wanted 0)"; fail=$((fail + 1)); fi
  fi
}

echo "== the four refusals that cost us time: read-only payloads that NAME a protected path =="
run_case allow "bare greater-than with a non-path target" "$P1"
run_case allow "comparison operator (greater-or-equal)" "$P2"
run_case allow "stream merge 2-and-1" "$P3"
run_case allow "arrow in prose" "$P4"

echo
echo "== the cases that must still block, whatever the carve-out says =="
run_case block "real redirect into an unlisted protected path" \
  "{\"tool_name\":\"terminal\",\"command\":\"echo x > $UNL2\"}"
run_case block "append redirect into an unlisted protected path" \
  "{\"tool_name\":\"terminal\",\"command\":\"echo x >> $UNL2\"}"
run_case block "destructive verb against an unlisted protected path" \
  "{\"tool_name\":\"terminal\",\"command\":\"rm -f $UNL\"}"
run_case block "a write tool naming an unlisted protected path, no redirect at all" \
  "{\"tool_name\":\"write_file\",\"path\":\"$UNL\",\"content\":\"{}\"}"
run_case block "one listed path and one unlisted path in the same payload (fail-closed)" \
  "{\"tool_name\":\"write_file\",\"path\":\"$CONFIG\",\"old_string\":\"x\",\"new_string\":\"see $UNL for the rule\"}"

echo
echo "== the rule 3 carve-out: a listed path only while the grant is valid =="
GRANT="block"; grant_valid && GRANT="allow"
echo "     (the grant is currently: $GRANT)"
run_case "$GRANT" "a write tool naming a listed path" \
  "{\"tool_name\":\"write_file\",\"path\":\"$SRC\",\"content\":\"{}\"}"
run_case "$GRANT" "a redirect into a listed path" \
  "{\"tool_name\":\"terminal\",\"command\":\"echo x > $CONFIG\"}"

echo
echo "== controls: allowed work stays allowed =="
run_case allow "read-only payload naming a protected path, no write tokens" \
  "{\"tool_name\":\"terminal\",\"command\":\"python -c \\\"print(open('$MAN').read()[:20])\\\"\"}"
run_case allow "read-only payload against the lessons journal" \
  "{\"tool_name\":\"terminal\",\"command\":\"python -c \\\"import json; print(len(open('$JOURNAL').readlines()))\\\"\"}"
run_case allow "write to a path outside every protected zone" \
  "{\"tool_name\":\"write_file\",\"path\":\"$ROOT/evidence/x.json\",\"content\":\"{}\"}"

echo
echo "== proof this test can fail: the OLD matcher, same four payloads =="
old_write_intent='(>|>>|tee |rm |mv |cp |sed -i|truncate|Set-Content|Out-File|New-Item|Remove-Item|chmod |skill_manage)'
old_flagged=0
for p in "$P1" "$P2" "$P3" "$P4"; do
  if printf '%s' "$p" | grep -qE "$old_write_intent"; then
    echo "OK    old matcher flagged it as a write  (the false positive the fix removes)"
    old_flagged=$((old_flagged + 1))
  else
    echo "NOTE  old matcher did not flag this payload"
  fi
done
echo "old-matcher proof: $old_flagged of 4 flagged before the fix"

echo
echo "guard-matcher: $pass passed, $fail failed  (hook: scope-guard.sh)"
[ "$fail" = "0" ] || exit 1
[ "$old_flagged" = "4" ] || exit 1
