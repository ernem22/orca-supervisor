#!/usr/bin/env node
// tests/guard-matcher.test.js — the scope-guard's matcher, exercised from the suite and not only by hand.
//
// The cases (the four false positives, the five write shapes that must still block, and rule 3's
// path-scoped carve-out) live in scripts/guard-matcher.test.sh, which runs the REAL hook and asserts its
// exit codes. This file runs that harness from the suite so the guard cannot regress unnoticed between
// reviews. It deliberately does not restate the cases: two copies of a policy test drift apart, and the
// copy that drifts is the one nobody runs.
//
// child_process here is fine — tests/single-exit-gate.test.js constrains src/ and bin/, and
// tests/tamper-check.js already shells out. The harness is the thing that runs the hook.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const V2 = 'D:/code/orca-supervisor';
const HARNESS = path.join(V2, 'scripts', 'guard-matcher.test.sh');
const HOOK = 'C:/Users/user/AppData/Local/hermes/profiles/orca-sup/hooks/scope-guard/scope-guard.sh';
const BASH = fs.existsSync('C:/Program Files/Git/bin/bash.exe') ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

test('the scope-guard matcher harness passes against the installed hook', (t) => {
  if (!fs.existsSync(HOOK)) return t.skip('the scope-guard hook is not installed in this profile');
  assert.ok(fs.existsSync(HARNESS), 'the harness must be present');
  const r = spawnSync(BASH, [HARNESS], { encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.strictEqual(r.status, 0, `harness exited ${r.status}\n${out}`);
  assert.match(out, /guard-matcher: \d+ passed, 0 failed/);
  assert.match(out, /old-matcher proof: 4 of 4 flagged before the fix/);
  assert.match(out, /the rule 3 carve-out/);
});
