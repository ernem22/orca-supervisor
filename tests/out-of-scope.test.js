// out-of-scope.test.js — an external arrival must be visible without reading as our failure.
//
// Context: a design-system-viewer worktree (`melusine`) appeared at 2026-09-23T15:35:15Z, created by
// nobody in this session. Because the manifest covers the repo and all its worktrees, those rows
// showed up as ~200 NEW failures — indistinguishable from the supervisor having broken something.
// The coordinator's decision: out of scope, but never silently dropped. These tests pin both halves
// of that: the rows are NOT counted as NEW, and they ARE named in the output.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const V2 = 'D:/code/orca-supervisor';
const guard = require(path.join(V2, 'src/guard/exec.js'));

function run() {
  const r = guard.run(['node', 'bin/verify-untouched'], { cwd: V2, dryRun: false, timeout: 300000 });
  // verify-untouched exits 1 whenever anything static changed, so its output must be read from the
  // full streams rather than from `error` (which stays a truncated human message).
  return [r.stdout, r.stderr, r.error].filter(Boolean).join('\n');
}

test('the out-of-scope list exists and names an external path with a decision', () => {
  const p = path.join(V2, 'manifest/out-of-scope.json');
  assert.ok(fs.existsSync(p), 'manifest/out-of-scope.json must exist');
  const entries = JSON.parse(fs.readFileSync(p, 'utf8')).entries;
  assert.ok(Array.isArray(entries) && entries.length > 0, 'at least one declared entry');
  for (const e of entries) {
    for (const f of ['prefix', 'decision', 'reason', 'first_seen']) {
      assert.ok(e[f] && String(e[f]).trim(), `entry is missing ${f}`);
    }
  }
});

test('verify-untouched separates out-of-scope rows from NEW failures', () => {
  const out = run();
  const observed = /OBSERVED \(out of scope, external\) : (\d+)/.exec(out);
  assert.ok(observed, 'the summary must carry an OBSERVED line');
  const n = Number(observed[1]);

  // Every OBSERVED row must sit under a declared prefix, and no OBSERVED row may also be a NEW row.
  // The count itself is not asserted to be > 0: an external arrival can be reaped, and a test that
  // demanded its permanent presence would fail for the right reason at the wrong time. What must hold
  // is the classification — declared prefixes never appear in the failure bucket.
  const declared = JSON.parse(fs.readFileSync(path.join(V2, 'manifest/out-of-scope.json'), 'utf8'))
    .entries.map(e => String(e.prefix).replace(/\\/g, '/').toLowerCase());
  const observedRows = [...out.matchAll(/^\s+OBSERVED (\S+)$/gm)].map(m => m[1].replace(/\\/g, '/').toLowerCase());
  const newRows = [...out.matchAll(/^\s+NEW {5}(\S+)$/gm)].map(m => m[1].replace(/\\/g, '/').toLowerCase());

  assert.strictEqual(observedRows.length, n, 'the counted number and the listed rows must agree');
  for (const r of observedRows) {
    assert.ok(declared.some(d => r.startsWith(d)), `OBSERVED row not under a declared prefix: ${r}`);
    assert.ok(!newRows.includes(r), `row counted as both OBSERVED and NEW: ${r}`);
  }
  for (const r of newRows) {
    assert.ok(!declared.some(d => r.startsWith(d)), `out-of-scope row still counted as NEW: ${r}`);
  }
});

test('an unreadable out-of-scope list is loud, not silent', () => {
  const src = fs.readFileSync(path.join(V2, 'bin/verify-untouched'), 'utf8');
  assert.ok(/out-of-scope list unreadable/.test(src),
    'the loader must report a read failure instead of returning an empty list silently');
});
