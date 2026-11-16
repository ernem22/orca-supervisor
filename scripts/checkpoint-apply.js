#!/usr/bin/env node
// scripts/checkpoint-apply.js — apply a checkpoint payload through the sanctioned writer.
//
//   node scripts/checkpoint-apply.js <handoff.md> <decisions.json> [checkpoint-module]
//
// The module defaults to ./src/checkpoint.js relative to the current directory, so the supervisor's
// own writer still does the validating, size-capping and atomic rename; this script only carries the
// payload, because checkpoint.js exposes no CLI for writes and a payload-editing one-shot like
// src/b1-seed.js would have to be written inside src/ (which the scope-guard refuses).
//
// Payload shape: decisions.json is an array of {kind, source, content, related?}; `ts` is stamped
// here so no timestamp is ever hand-typed. The handoff is written FIRST and the appends are skipped
// if it is refused — a re-run duplicates appended lines, and appends are irreversible by design.

const fs = require('fs');
const path = require('path');

const [handoffFile, decisionsFile, moduleArg] = process.argv.slice(2);
if (!handoffFile) {
  console.log('usage: node scripts/checkpoint-apply.js <handoff.md> [decisions.json] [checkpoint-module]');
  process.exit(2);
}

const modulePath = path.resolve(process.cwd(), moduleArg || './src/checkpoint.js');
const { appendDecision, writeHandoff, JOURNAL, HANDOFF } = require(modulePath);

const handoffText = fs.readFileSync(handoffFile, 'utf8');
let decisions = [];
if (decisionsFile) {
  decisions = JSON.parse(fs.readFileSync(decisionsFile, 'utf8'));
  if (!Array.isArray(decisions)) {
    console.log('REJECTED: the decisions payload must be a JSON array');
    process.exit(2);
  }
}

const h = writeHandoff(handoffText);
if (!h.ok) {
  console.log(`handoff REJECTED (nothing appended): ${h.errors.join('; ')}`);
  process.exit(1);
}
console.log(`handoff written: ${h.bytes} B (cap 2048) -> ${HANDOFF}`);

const ts = new Date().toISOString();
let failed = false;
for (const d of decisions) {
  const r = appendDecision({ ...d, ts });
  if (r.ok) console.log(`appended [${d.kind}] ${r.bytes} B @ ${ts}`);
  else { failed = true; console.log(`REJECTED [${d.kind}]: ${r.errors.join('; ')}`); }
}

// Read both files back: a write that is not read back is not evidence.
const lines = fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean);
const back = fs.readFileSync(HANDOFF, 'utf8');
console.log(`\njournal now ${lines.length} line(s); last ${decisions.length} appended above.`);
console.log(`handoff back: ${Buffer.byteLength(back, 'utf8')} B; headings ` +
  ['## Now', '## Next', '## Waiting on', '## Risks'].filter((x) => back.includes(x)).join(' | '));
console.log(`journal path ${path.basename(JOURNAL)} | handoff path ${path.basename(HANDOFF)}`);

process.exit(failed ? 1 : 0);
