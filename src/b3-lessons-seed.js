#!/usr/bin/env node
// b3-lessons-seed.js — seed journal/lessons.jsonl (B3 b) with the six known failure classes.
// Append-only, schema-validated. Re-running refuses unless --force, so a real lesson added later
// is never buried under a duplicate seed.
const fs = require('fs');
const path = require('path');

const FILE = 'D:/code/orca-supervisor/journal/lessons.jsonl';
const FIELDS = ['symptom', 'root_cause', 'evidence', 'proposed_rule', 'status'];
const STATUSES = ['proposed', 'accepted', 'rejected'];

function validate(l) {
  const e = [];
  for (const f of FIELDS) if (!(f in l)) e.push(`missing field: ${f}`);
  if (l.status && !STATUSES.includes(l.status)) e.push(`status must be one of ${STATUSES.join('|')}`);
  for (const f of ['symptom', 'root_cause', 'evidence', 'proposed_rule']) {
    if (typeof l[f] !== 'string' || !l[f].trim()) e.push(`${f} must be a non-empty string`);
  }
  return e;
}

const SEEDS = [
  {
    symptom: 'A settlement sat unnoticed for twenty hours; the coordinator believed a watcher was running.',
    root_cause: 'The watcher was single-shot: it exits on the first event, and re-arming it is a rule that lives only in a document that context compaction removes.',
    evidence: 'watchd stopped by a stop file at 2026-09-21; no watcher after 15:41Z; fixer died and the 04:00 cron rewrote the skill with nobody watching.',
    proposed_rule: 'The supervisor process must be long-lived and self-restarting; never rely on a rule that only exists in prose.',
    status: 'proposed',
  },
  {
    symptom: 'A finished worker was never collected: its verdict was posted, its terminal lingered, and it was classified as stalled.',
    root_cause: 'The stall detector watched every opencode terminal instead of the terminals whose TASK is still dispatched; a finished worker keeps its terminal.',
    evidence: 'First detector run flagged 4 workers, 2 of them finished (reviewer-123, tester-123); after filtering to task status=dispatched only the genuine stall remained.',
    proposed_rule: 'Liveness is decided from task/dispatch state, never from terminal presence.',
    status: 'proposed',
  },
  {
    symptom: 'An agent turn ended mid-report with "Cannot connect to API", leaving the work done and unreported.',
    root_cause: 'A transport drop is treated as the end of a turn, not as a failure to be retried; the session stays alive but wedged, and queued input never arrives.',
    evidence: 'opencode.log 13:17:05-13:18:25Z: five "stream error" then "Cannot connect to API"; the terminal showed the dotted idle bar with no timer; three retries of terminal send did nothing.',
    proposed_rule: 'Classify transport drops as provider-disconnect (positive evidence), replace the agent in the same worktree, and never count a retry against a budget.',
    status: 'proposed',
  },
  {
    symptom: 'C: filled to 96% and agents died with "memory full" while ports stayed bound to dead previews.',
    root_cause: 'Reaping removed the worktree but left the preview server running out of it, and the kill command used was a silent no-op.',
    evidence: '13 orphaned vite previews found; taskkill //F //PID returns "Invalid argument/option" under this shell and no-ops, so every earlier "kill" had failed.',
    proposed_rule: 'Kill servers before removing the worktree, with taskkill -F -PID; verify a kill by checking the port, never by the exit code alone.',
    status: 'proposed',
  },
  {
    symptom: 'Dispatched specs deviated from what was intended: wrong PR number, wrong port, unfilled placeholders, a missing verdict step.',
    root_cause: 'Specs were derived from other specs by text substitution instead of being authored per dispatch, so numbers changed while the claims did not.',
    evidence: 'Three sed-derived specs (reviewer-123 reviewed the wrong PR), two wrong ports (tester-114b/c), two unfilled file sets, three skipped verdict-comment steps.',
    proposed_rule: 'A spec is authored per dispatch and linted: no unfilled <...>, PR/issue numbers consistent inside the template, port inside the reserved range, the verdict-comment step present.',
    status: 'proposed',
  },
  {
    symptom: 'Every worker ran on an operator-created terminal, so Orca accounting never converged (151/151 retained) and the plain-shell race had to be re-solved by hand.',
    root_cause: 'The spawn helper builds worktree and terminal itself and then attaches with --terminal, which the Orca guide classes as an unsupervised operator-created process.',
    evidence: 'worker-list: 98/100 records projection.resource.state=external; the guide calls worker-start the normal path, composing placement, terminal readiness, prompt injection and supervised resource ownership.',
    proposed_rule: 'Use the supervised path (worker-start with --worktree/--agent) for new workers; keep the external route only where it is measurably better.',
    status: 'proposed',
  },
];

if (fs.existsSync(FILE) && fs.readFileSync(FILE, 'utf8').trim() && !process.argv.includes('--force')) {
  console.log(`lessons.jsonl already has content; refusing to seed twice (use --force)`);
  process.exit(0);
}
fs.mkdirSync(path.dirname(FILE), { recursive: true });
let ok = 0, bad = 0;
for (const l of SEEDS) {
  const errs = validate(l);
  if (errs.length) { bad++; console.log(`REJECTED: ${JSON.stringify(errs)}`); continue; }
  fs.appendFileSync(FILE, JSON.stringify(l) + '\n');
  ok++;
}
console.log(`seeded ${ok} lesson(s), ${bad} rejected`);
console.log(`file: ${FILE} (${fs.statSync(FILE).size} B, ${fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).length} lines)`);
