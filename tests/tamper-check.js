#!/usr/bin/env node
// tamper-test.js — prove verify-untouched DETECTS a deliberate change, without touching any
// protected file. It tampers with a COPY of the manifest, not with the filesystem under watch.
//
//   node tests/tamper-test.js
//
// Exit 0 = the detector behaved exactly as expected (1 CHANGED, 1 MISSING, 1 NEW, exit 1).
// It writes only inside D:/code/orca-supervisor/evidence/A0/.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const V2 = 'D:/code/orca-supervisor';
const SRC = path.join(V2, 'manifest/protected.json');
const COPY = path.join(V2, 'evidence/A0/manifest-tampered.json');
const OUT = path.join(V2, 'evidence/A0/tamper-test.output.txt');

const m = JSON.parse(fs.readFileSync(SRC, 'utf8'));
if (m.files.length < 3) { console.error('tamper-test: manifest too small'); process.exit(2); }

// 1. a file whose content "changed": flip its recorded hash
m.files[0].sha256 = 'f'.repeat(64);
// 2. a protected file that "disappeared": drop its row
const removed = m.files.splice(1, 1)[0];
// 3. a new file appearing under a protected zone
m.files.push({
  zone: m.files[0].zone, path: 'D:/code/orca-supervisor/evidence/A0/planted-new-file.txt',
  rel: 'planted-new-file.txt', size: 1, mtime_ms: Date.now(), sha256: 'a'.repeat(64),
});

fs.writeFileSync(COPY, JSON.stringify(m, null, 1));

let out = '', code = 0;
try {
  out = execFileSync(process.execPath, [path.join(V2, 'bin/verify-untouched'), '--manifest', COPY], {
    encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 600000,
  });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  code = e.status;
}
fs.writeFileSync(OUT, `$ node bin/verify-untouched --manifest ${COPY}\n${out}\nexit=${code}\n`);
console.log(out);
console.log(`exit=${code}`);
console.log(`tampered copy : ${COPY}`);
console.log(`removed row   : ${removed.path}`);
const ok = /CHANGED\s*:\s*1/.test(out) && /MISSING\s*:\s*1/.test(out) && /NEW\s*:\s*1/.test(out) && code === 1;
console.log(ok ? 'tamper-test: PASS (deliberate change detected)' : 'tamper-test: FAIL');
process.exit(ok ? 0 : 1);
