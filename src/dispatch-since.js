#!/usr/bin/env node
// dispatch-since.js — read-only. Every dispatch created since a cut-off, with how it was launched.
//
// The worker-list record carries no timestamp, so the date comes from the TASK it belongs to
// (task.created_at), which is when the dispatch was created. Launch method comes from
// projection.resource.state: "external" = an operator-created terminal (spawn.sh route),
// anything else = Orca's own supervised path (worker-start --agent).
const fs = require('fs');
const path = require('path');
const guard = require('./guard/exec.js');

const CUT = '2026-09-21T15:34:33Z';
const TMP = path.join(process.env.LOCALAPPDATA || '', 'Temp');
// Every process call goes through the single exit gate (A1 rule, enforced by tests/single-exit-gate.test.js).
const sh = (cmd, args, cwd) => {
  const r = guard.run([cmd, ...args], { cwd, dryRun: false, timeout: 120000 });
  if (r.ok) return String(r.stdout || '').trim();
  if (r.decision && !r.decision.allow) return `DENIED(${r.decision.rule})`;
  return `ERROR: ${String(r.error || '').slice(0, 200)}`;
};

fs.writeFileSync(path.join(TMP, 'ds-tasks.json'), sh('orca', ['orchestration', 'task-list', '--json']));
fs.writeFileSync(path.join(TMP, 'ds-workers.json'), sh('orca', ['orchestration', 'worker-list', '--run', 'run_4e539259ab29', '--json']));
fs.writeFileSync(path.join(TMP, 'ds-terminals.json'), sh('orca', ['terminal', 'list', '--json']));

const tasks = (JSON.parse(fs.readFileSync(path.join(TMP, 'ds-tasks.json'), 'utf8')).result || {}).tasks || [];
const workers = (JSON.parse(fs.readFileSync(path.join(TMP, 'ds-workers.json'), 'utf8')).result || {}).workers || [];
const terminals = (JSON.parse(fs.readFileSync(path.join(TMP, 'ds-terminals.json'), 'utf8')).result || {}).terminals || [];

const wByTask = new Map(workers.map(w => [w.taskId, w]));
const tByHandle = new Map(terminals.map(t => [t.handle, t]));

const cutMs = Date.parse(CUT);
const recent = tasks
  .filter(t => t.created_at && Date.parse(t.created_at) >= cutMs)
  .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

console.log(`cut-off: ${CUT}   (now ${new Date().toISOString()})`);
console.log(`tasks created since the cut-off: ${recent.length}   (of ${tasks.length} total)\n`);

let anySupervised = false;
for (const t of recent) {
  const w = wByTask.get(t.id);
  const p = (w && w.projection) || {};
  const state = (p.resource || {}).state || '(no projection)';
  const term = w ? tByHandle.get(w.agentTerminalHandle) : null;
  const agent = term ? (term.agentIdentity || 'shell') : '-';
  if (state !== 'external' && state !== '(no projection)') anySupervised = true;
  console.log(`${t.created_at} | ${t.id} | ${t.status}`);
  console.log(`   title    : ${(t.task_title || '').slice(0, 78)}`);
  console.log(`   dispatch : ${w ? w.dispatchId : '(none)'}  launch=${state}  agent=${agent}  model=${p.model || '(not recorded)'}`);
  console.log(`   result   : ${String(t.result || '(none)').slice(0, 110)}`);
}

console.log(`\n--- verdict ---`);
console.log(`dispatches launched via Orca's supervised path (worker-start --agent) in this window: ${anySupervised ? 'YES' : 'NONE'}`);
console.log(`all other dispatches in this window were launched on operator-created terminals (external).`);
