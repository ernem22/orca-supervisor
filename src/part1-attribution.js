#!/usr/bin/env node
// part1-attribution.js — read-only. Answer precisely: at 15:34:33Z did THIS session call
// skill_manage on the pipeline skill, or did a background process write without a call?
//
// The ledger's `actor` field is the discriminator: `agent` = a tool call from a session,
// `curator` = the curator's own background write. `evidence.session_id` names the session the
// entry is attributed to, which is NOT the same thing as "the session issued the write".
const fs = require('fs');
const path = require('path');

const H = path.join(process.env.LOCALAPPDATA || '', 'hermes');
const LEDGER = path.join(H, 'skills', '.curator_ledger.jsonl');
const MY_SESSION = '20260918_174011_c8d3a3';   // this session
const SINCE = '2026-09-21T15:24';

const lines = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
const rows = [];
for (const l of lines) {
  let j; try { j = JSON.parse(l); } catch { continue; }
  if (!j.ts || !j.ts.startsWith(SINCE.slice(0, 13))) continue;   // same hour window
  if (j.ts < SINCE) continue;
  rows.push(j);
}
rows.sort((a, b) => a.ts.localeCompare(b.ts));

console.log(`ledger entries since ${SINCE}Z : ${rows.length}`);
console.log('ts                              | actor   | action | skill                              | session');
for (const j of rows) {
  console.log(`${j.ts} | ${String(j.actor).padEnd(7)} | ${String(j.action).padEnd(6)} | ${String(j.skill).padEnd(34)} | ${(j.evidence || {}).session_id || '-'}`);
}

const mine = rows.filter(j => j.actor === 'agent' && (j.evidence || {}).session_id === MY_SESSION);
const curator = rows.filter(j => j.actor === 'curator');
console.log(`\nentries attributed to THIS session with actor=agent (i.e. a tool call I made): ${mine.length}`);
for (const j of mine) console.log(`  ${j.ts} ${j.action} ${j.skill}`);
console.log(`entries with actor=curator in the window: ${curator.length}`);
for (const j of curator) console.log(`  ${j.ts} ${j.action} ${j.skill} (session ${(j.evidence || {}).session_id || '-'})`);

console.log('\nlast 6 agent-actor entries for this skill, any time (my own tool calls):');
const mineAll = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(j => j && j.actor === 'agent' && /worker-pipelines/.test(j.skill || ''))
  .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
for (const j of mineAll.slice(-6)) console.log(`  ${j.ts} ${j.action} (session ${(j.evidence || {}).session_id || '-'})`);
