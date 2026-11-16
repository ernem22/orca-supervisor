#!/usr/bin/env node
// manifest-loud-fail.test.js — build-manifest must FAIL LOUDLY when a protected zone disappears,
// never silently substitute something else for it.
//
// The first version quietly fell back to the repo root when the worktree list failed to parse, and
// produced a manifest that looked complete with proteus-5 missing (777 files instead of 987).
//
//   node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const V2 = 'D:/code/orca-supervisor';
const { missingZones } = require(path.join(V2, 'src/build-manifest.js'));
const guard = require(path.join(V2, 'src/guard/exec.js'));

test('missingZones reports a protected path that the current set no longer covers', () => {
  const prev = ['D:/code/design-system-viewer', 'C:/Users/user/orca/workspaces/design-system-viewer/proteus-5'];
  assert.deepStrictEqual(
    missingZones(prev, ['D:/code/design-system-viewer']),
    ['C:/Users/user/orca/workspaces/design-system-viewer/proteus-5'],
  );
  assert.deepStrictEqual(missingZones(prev, prev), [], 'no loss when nothing is lost');
  assert.deepStrictEqual(missingZones([], prev), [], 'nothing to lose on a first run');
});

test('build-manifest exits non-zero and names the zone when a protected worktree is absent', () => {
  // The seam: SUP_SIMULATE_MISSING_ZONE removes a path from the set exactly as a failed
  // `worktree list` would, without touching the real worktree.
  const r = guard.run(['node', 'src/build-manifest.js', '--stdout'], {
    cwd: V2, dryRun: false, timeout: 300000,
    env: { ...process.env, SUP_SIMULATE_MISSING_ZONE: 'C:/Users/user/orca/workspaces/design-system-viewer/proteus-5' },
  });
  assert.strictEqual(r.ok, false, 'a lost protected zone must not produce a manifest');
  assert.strictEqual(r.exit, 3, 'exit code 3 is the documented refusal');
  assert.match(r.error, /REFUSING TO WRITE/, 'the message must say it refused');
  assert.match(r.error, /proteus-5/, 'the message must name the missing zone');
});

test('a normal run still succeeds and covers every design-system-viewer worktree', () => {
  const clean = guard.run(['node', 'src/build-manifest.js', '--stdout'], { cwd: V2, dryRun: false, timeout: 300000 });
  assert.strictEqual(clean.ok, true, 'a normal run must still succeed');
  const parsed = JSON.parse(clean.stdout);
  assert.ok(parsed.dynamic.worktrees.some(w => w.includes('proteus-5')), 'proteus-5 must be covered');
  // The count is not an invariant: worktrees are created and reaped as work proceeds, and a
  // hard-coded number turns every new worktree into a red suite (it did, for `melusine`). What must
  // hold is the SCOPING: at least the coordinator tree plus proteus-5, and nothing from another repo.
  assert.ok(parsed.dynamic.worktrees.length >= 2, 'at least the coordinator worktree and proteus-5 are covered');
  assert.ok(
    parsed.dynamic.worktrees.every(w => w.includes('design-system-viewer')),
    'no worktree from another repo may leak into the manifest',
  );
});
