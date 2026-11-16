#!/usr/bin/env node
// diag-skills-gap.js — why does hermes:skills count 583 in the manifest and 584 under `find`?
// Read-only diagnostic. Prints the file(s) present in one count and absent from the other.
const fs = require('fs');
const path = require('path');

const V2 = 'D:/code/orca-supervisor';
const H = path.join(process.env.LOCALAPPDATA || '', 'hermes', 'skills');
const EXCLUDES = ['node_modules', 'dist', '.git', '.vite', 'coverage'];
const norm = (p) => p.split('\\').join('/').toLowerCase();

const m = JSON.parse(fs.readFileSync(path.join(V2, 'manifest/protected.json'), 'utf8'));
const inManifest = new Set(m.files.filter(f => f.zone === 'hermes:skills').map(f => norm(f.path)));

const symlinks = [];
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isSymbolicLink()) { symlinks.push(p); continue; }
    if (e.isDirectory()) { if (!EXCLUDES.includes(e.name)) walk(p); continue; }
    files.push(p);
  }
})(H);

const missingFromManifest = files.filter(p => !inManifest.has(norm(p)));
const extraInManifest = [...inManifest].filter(p => !files.map(norm).includes(p));

console.log(`manifest rows (hermes:skills) : ${inManifest.size}`);
console.log(`fs walk, symlinks excluded    : ${files.length}`);
console.log(`symlinks skipped by the walk  : ${symlinks.length}`);
console.log(`in the walk, NOT in manifest  : ${missingFromManifest.length}`);
missingFromManifest.forEach(p => console.log(`   ${p}`));
console.log(`in the manifest, NOT in walk  : ${extraInManifest.length}`);
extraInManifest.forEach(p => console.log(`   ${p}`));
symlinks.forEach(p => console.log(`   SYMLINK ${p}`));
