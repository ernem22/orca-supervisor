#!/usr/bin/env node
// src/sandbox-drill.js — run a command through the gate in SANDBOX MODE.
//
// E1's drill needs Orca's write verbs, and they must still go through the guard: the whole point of
// the single exit gate is that no drill gets to bypass it. This driver sets SUP_SANDBOX=1, which the
// guard reads to enable its sandbox-only allow list — and that list refuses a worker-start whose
// worktree is not under the sandbox root, so the live Run stays out of reach even here.
//
// Every call is printed with the guard's own decision, so the raw output of a scenario includes the
// reason a command was allowed, not just that it ran.
//
// Usage: node src/sandbox-drill.js <argv...>
const path = require('path');
const guard = require(path.join(__dirname, 'guard', 'exec.js'));

const argv = process.argv.slice(2);
if (!argv.length) { console.error('usage: node src/sandbox-drill.js <command> [args...]'); process.exit(2); }

const env = { ...process.env, SUP_SANDBOX: '1' };
// cwd goes to the DECISION as well as the run: the sandbox's managed-worktree rule is cwd-scoped, and a
// pre-check that omitted the cwd would deny a command the run itself would allow.
const cwd = process.cwd();
const d = guard.decide(argv, { env, cwd });
console.log(`$ ${argv.join(' ')}`);
console.log(`  guard: ${d.allow ? 'ALLOW' : 'DENY'} (${d.rule}) ${d.reason}`);
if (!d.allow) process.exit(3);

// The cwd is the CALLER's: a managed worktree creation resolves the repo from the working directory,
// and a driver that always ran in the v2 repo would have created a worktree of the wrong repository.
const r = guard.run(argv, { cwd: process.cwd(), dryRun: false, timeout: 180000, env });
if (!r.ok) {
  console.log(`  exit: ${r.exit}`);
  console.log(String(r.stdout || r.error || '').slice(0, 1200));
  process.exit(r.exit || 1);
}
console.log(`  exit: 0`);
console.log(String(r.stdout || '').slice(0, 200000));
