#!/usr/bin/env node
// single-exit-gate.test.js — mechanical enforcement of A1's rule: src/guard/exec.js is the ONLY
// file that may start a process.
//
// A convention that is only written down is a convention that erodes. This walks src/ and bin/
// and fails if any other file imports child_process, calls spawn/exec/execFile, or shells out.
//
//   node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const V2 = 'D:/code/orca-supervisor';
const GATE = path.join(V2, 'src/guard/exec.js');

// Patterns that mean "this file can start a process".
const VIOLATIONS = [
  { re: /require\(\s*['"]child_process['"]\s*\)/, what: 'imports child_process' },
  { re: /from\s+['"]child_process['"]/, what: 'imports child_process' },
  { re: /require\(\s*['"]node:child_process['"]\s*\)/, what: 'imports node:child_process' },
  { re: /\.spawn\s*\(/, what: 'calls spawn()' },
  { re: /\bexecFileSync\s*\(/, what: 'calls execFileSync()' },
  { re: /\bexecSync\s*\(/, what: 'calls execSync()' },
];

function jsFilesUnder(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...jsFilesUnder(p)); continue; }
    if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('src/ and bin/ contain exactly one process-starting file: src/guard/exec.js', () => {
  const files = [...jsFilesUnder(path.join(V2, 'src')), ...jsFilesUnder(path.join(V2, 'bin'))];
  assert.ok(files.length > 0, 'expected to find js files to check');
  assert.ok(files.map(p => path.resolve(p)).includes(path.resolve(GATE)), 'the gate itself must be among the files');

  const offenders = [];
  for (const f of files) {
    if (path.resolve(f) === path.resolve(GATE)) continue;
    const src = fs.readFileSync(f, 'utf8');
    for (const v of VIOLATIONS) {
      if (v.re.test(src)) offenders.push(`${path.relative(V2, f)}: ${v.what}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `these files bypass the single exit gate:\n  ${offenders.join('\n  ')}`);
});

test('the gate itself does import child_process (so the rule above is not vacuous)', () => {
  const src = fs.readFileSync(GATE, 'utf8');
  assert.match(src, /require\(\s*['"]child_process['"]\s*\)/, 'exec.js must be the one file that can spawn');
});
