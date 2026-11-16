#!/usr/bin/env node
// verify-untouched.test.js — a runtime-volatile row that is briefly absent must not read as a static
// failure, and a row without that flag must still fail.
//
// The case is real, not hypothetical: Orca replaces its own settings file rather than editing it in
// place, so on 2026-09-27 a check landed in the gap and reported the freshly-protected oca-settings row
// as MISSING — a static failure for a file that was back minutes later. A verifier that fails for a
// reason nobody can act on is a verifier people stop reading.
//
// The simulation is a synthetic manifest: the real one, plus two rows pointing at files that do not
// exist — one flagged runtime_volatile, one not. One checker run proves both halves at once, and the
// exit code stays deterministic because the unflagged row really is missing.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const V2 = 'D:/code/orca-supervisor';
const guard = require(path.join(V2, 'src/guard/exec.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-untouched-test-'));
const absentVolatile = path.join(tmp, 'gone-volatile.json').split(path.sep).join('/');
const absentStatic = path.join(tmp, 'gone-static.json').split(path.sep).join('/');
const synthetic = path.join(tmp, 'protected.synthetic.json');

{
  const m = JSON.parse(fs.readFileSync(path.join(V2, 'manifest/protected.json'), 'utf8'));
  const row = (p, rel, extra) => ({
    zone: 'orca:settings', path: p, rel, size: 1, mtime_ms: 1, sha256: '0'.repeat(64), ...extra,
  });
  m.files.push(row(absentVolatile, 'gone-volatile.json', { runtime_volatile: true }));
  m.files.push(row(absentStatic, 'gone-static.json', {}));
  fs.writeFileSync(synthetic, JSON.stringify(m, null, 1));
}

test('a transiently absent runtime-volatile row reads RUNTIME, while a plain missing row still fails', () => {
  const r = guard.run(['node', 'bin/verify-untouched', '--manifest', synthetic],
    { cwd: V2, dryRun: false, timeout: 300000 });
  // verify-untouched exits 1 whenever anything static changed, so read the streams, not `error`.
  const out = [r.stdout, r.stderr, r.error].filter(Boolean).join('\n');

  // 1. The volatile row is named, and named as the runtime class — not silently dropped.
  assert.match(out, new RegExp(`RUNTIME-MISSING ${absentVolatile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    'the absent volatile row must be reported as RUNTIME-MISSING');
  assert.match(out, /RUNTIME MISSING\s+: [1-9]\d*/, 'the runtime-missing count must include it');

  // 2. It is NOT counted as a static MISSING row.
  assert.ok(!new RegExp(`^\\s+MISSING ${absentVolatile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(out),
    'a runtime-volatile row must never appear in the static MISSING list');

  // 3. The control still fails: a row without the flag is MISSING and the run exits 1.
  assert.match(out, new RegExp(`MISSING ${absentStatic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    'an unflagged absent row must still be reported MISSING');
  assert.match(out, /MISSING\s+: [1-9]\d*/, 'the static missing count must include it');
  assert.strictEqual(r.exit ?? r.code, 1, `the static failure must fail the run (output below)\n${out}`);
});
