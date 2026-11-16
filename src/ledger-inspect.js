#!/usr/bin/env node
// ledger-inspect.js — read-only: what did the curator change in the pipeline skill, and does a
// backup of the pre-patch content exist?
const fs = require('fs');
const path = require('path');

const H = path.join(process.env.LOCALAPPDATA || '', 'hermes');
const LEDGER = path.join(H, 'skills', '.curator_ledger.jsonl');

const lines = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
console.log(`ledger records total: ${lines.length}`);

const hits = [];
for (const l of lines) {
  let j; try { j = JSON.parse(l); } catch { continue; }
  if (/worker-pipelines/.test(j.skill || '')) hits.push(j);
}
console.log(`records touching orca-opencode-worker-pipelines: ${hits.length}`);
for (const j of hits) {
  console.log(`  ts=${j.ts} actor=${j.actor} action=${j.action} skill=${j.skill} session=${(j.evidence || {}).session_id || '-'}`);
  const b = j.before;
  if (Array.isArray(b)) {
    console.log(`    before: array of ${b.length}`);
    for (const e of b.slice(0, 6)) {
      console.log(`      path=${e.path}`);
      console.log(`      keys=${Object.keys(e).join(',')}`);
      for (const k of Object.keys(e)) {
        if (k === 'path') continue;
        const v = e[k];
        console.log(`      ${k}: ${typeof v === 'string' ? `${v.length} chars` : JSON.stringify(v).slice(0, 120)}`);
      }
    }
  } else {
    console.log(`    before: ${typeof b}`);
  }
}

// Does the curator keep a copy of the pre-patch file anywhere?
const reportDir = path.join(H, 'logs', 'curator');
if (fs.existsSync(reportDir)) {
  const runs = fs.readdirSync(reportDir);
  console.log(`curator report dirs: ${runs.length} -> ${runs.slice(0, 5).join(', ')}`);
  for (const r of runs.slice(0, 3)) {
    const d = path.join(reportDir, r);
    console.log(`  ${r}/: ${fs.readdirSync(d).slice(0, 10).join(', ')}`);
  }
} else {
  console.log('no curator report dir');
}
