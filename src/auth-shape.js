#!/usr/bin/env node
// auth-shape.js — read-only, and it NEVER prints a secret value.
// It answers: where does the opencode-go credential live, and is a value actually stored?
const fs = require('fs');
const path = require('path');

const H = path.join(process.env.LOCALAPPDATA || '', 'hermes');
const PROF = path.join(H, 'profiles', 'orca-sup');

function describe(label, file) {
  if (!fs.existsSync(file)) { console.log(`${label}: (no file)`); return; }
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log(`${label}: unparseable (${e.message})`); return; }
  console.log(`${label}: ${file}`);
  console.log(`  size=${fs.statSync(file).size} B  top-level keys: ${Object.keys(j).join(', ')}`);
  const walk = (o, prefix, depth) => {
    if (depth > 3 || o === null || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      const p = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) { walk(v, p, depth + 1); continue; }
      if (Array.isArray(v)) { console.log(`    ${p}: array[${v.length}]`); continue; }
      if (typeof v === 'string') {
        const looksSecret = /key|token|secret|password/i.test(k);
        console.log(`    ${p}: string(len=${v.length})${looksSecret ? '  [value withheld]' : ' = ' + JSON.stringify(v).slice(0, 60)}`);
      } else {
        console.log(`    ${p}: ${typeof v} = ${JSON.stringify(v)}`);
      }
    }
  };
  walk(j, '', 1);
}

describe('MAIN auth.json', path.join(H, 'auth.json'));
describe('PROFILE auth.json', path.join(PROF, 'auth.json'));
describe('PROFILE .env', path.join(PROF, '.env'));

// opencode's own credential store (separate from Hermes)
const ocRoots = [
  path.join(process.env.LOCALAPPDATA || '', '..', '..', '.local', 'share', 'opencode'),
  path.join(require('os').homedir(), '.local', 'share', 'opencode'),
  path.join(require('os').homedir(), '.config', 'opencode'),
];
for (const r of ocRoots) {
  if (!fs.existsSync(r)) { console.log(`opencode store: (absent) ${r}`); continue; }
  console.log(`opencode store: ${r}`);
  for (const f of fs.readdirSync(r)) console.log(`  ${f}${fs.statSync(path.join(r, f)).isDirectory() ? '/' : ` (${fs.statSync(path.join(r, f)).size} B)`}`);
}
