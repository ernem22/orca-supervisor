#!/usr/bin/env node
// b1-seed.js — write the real handoff.md and seed the journal with this session's decisions.
// One-shot; safe to re-run (appendDecision is append-only, so re-running duplicates lines — the
// script refuses to seed twice unless --force).
const fs = require('fs');
const { writeHandoff, appendDecision, readDecisions, JOURNAL } = require('./checkpoint.js');

const force = process.argv.includes('--force');
const existing = readDecisions(1);
if (existing.total && !force) {
  console.log(`journal already has ${existing.total} decision(s); refusing to seed twice (use --force)`);
} else {
  const handoff = `## Now
Building the v2 supervisor BESIDE the live pipeline. A0–A3 done; B1 (lossless state model) done.
No pipeline file, skill, cron job, worktree or worker has been touched.

## Next
B2 — lossless compression design (docs/compaction-design.md), built on the \`session:compress\` hook
event found in A2(f) and the re-orientation protocol in docs/state-model.md.

## Waiting on
B3 (c/d/e) approvals, C4, D1 under-load measurement, E1 sandbox, F1. A3's credential was supplied by
the user; the profile is logged in and its hello test passes.

## Risks
The live pipeline skill is rewritten in the background every few turns (curator / background review);
backups/skills/ snapshots are the only recoverable copy. The supervisor runbook must be pinned AND
under skills.write_approval — pin alone does not block an agent-side self-edit.
`;
  const h = writeHandoff(handoff);
  console.log('handoff:', JSON.stringify(h));

  const decisions = [
    { ts: '2026-09-21T15:34:33Z', kind: 'focus', source: 'user', content: 'Build a supervisor layer beside the existing pipeline and never modify the pipeline, its files, skills, cron jobs or running workers.', related: {} },
    { ts: '2026-09-21T15:40:00Z', kind: 'preference', source: 'user', content: 'One model everywhere: opencode-go/deepseek-v4.1-flash, for the coordinator and every worker.', related: {} },
    { ts: '2026-09-21T16:45:00Z', kind: 'preference', source: 'self', content: 'Serialise browser-driving testers: never more than one at a time, because three in parallel wedged and the machine is 7.5 GB.', related: {} },
    { ts: '2026-09-22T13:24:32Z', kind: 'deviation', source: 'self', content: 'Concluded that pin alone does not block an agent-side skill patch, after a pinned throwaway skill was patched successfully; B3 must also use skills.write_approval.', related: {} },
    { ts: '2026-09-22T13:25:00Z', kind: 'question', source: 'self', content: 'Asked the user whether to authorise copying the main profile credential into orca-sup, and refused to copy a secret unasked; the user ran the auth command instead.', related: {} },
    { ts: '2026-09-22T13:39:00Z', kind: 'approval', source: 'user', content: 'Approved A3 with PART 2 precautions, then confirmed the credential and asked for the closing report.', related: {} },
  ];
  for (const d of decisions) {
    const r = appendDecision(d);
    console.log(r.ok ? `decision ok (${r.bytes} B): ${d.kind}/${d.source}` : `decision REJECTED: ${JSON.stringify(r.errors)}`);
  }
}
console.log(`\njournal: ${JOURNAL}`);
console.log(`handoff bytes: ${fs.existsSync('D:/code/orca-supervisor/handoff.md') ? fs.statSync('D:/code/orca-supervisor/handoff.md').size : 0}`);
