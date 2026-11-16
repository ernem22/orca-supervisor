#!/usr/bin/env node
// src/reconcile.js — C3: turn a classification into PROPOSALS. It executes nothing.
//
// There is no process gate here because this file starts no process: it reads two JSON documents and
// writes a third. If a future change wants it to act, that is a different component with its own
// approval — not an edit to this one.
//
// The rule that shapes every row (docs/decision-table.md): a destructive action is proposed only when
// the work is PUSHED and the STATE IS KNOWN. Otherwise the row degrades to `escalate` with the reason
// recorded. Rows resting on `absence` evidence may only `escalate`.
const fs = require('fs');
const path = require('path');

const DESTRUCTIVE = new Set(['abandon', 'reap']);

/**
 * @param snapshot       a document from src/snapshot.js
 * @param classification a document from src/classify.js
 * @param opts.capacity  { free_slots: n } from D1, or omitted when unknown
 * @param opts.issues    eligible issues; defaults to the snapshot's, filtered by label
 */
function reconcile(snapshot, classification, opts = {}) {
  const rows = [];
  const notes = [];
  const prByTask = new Map();
  for (const r of snapshot.derived.task_terminal_pr_table || []) prByTask.set(r.task_id, r.pr || null);

  const push = (o) => rows.push({
    action: o.action,
    target: o.target,
    reason: o.reason,
    safe: o.safe,
    preconditions: o.preconditions || [],
    evidence_kind: o.evidence_kind,
    source_class: o.source_class,
  });

  /** The safety gate. Both halves are required, and the missing half is named in the reason. */
  function destructive(action, row, extra = []) {
    const pr = row.task_id ? prByTask.get(row.task_id) : null;
    const pushed = !!pr;
    const known = row.evidence_kind === 'positive';
    const pre = [
      'the work is pushed (an open PR exists for this task)',
      'the state is known (positive evidence, not absence)',
      ...extra,
    ];
    if (pushed && known) {
      push({ action, target: row.task_id, reason: row.reason, safe: true, preconditions: pre, evidence_kind: row.evidence_kind, source_class: row.class });
      return true;
    }
    const missing = !pushed ? 'the work is NOT pushed (no open PR) — fencing could lose local-only work' : 'the state is not known (absence evidence)';
    push({ action: 'escalate', target: row.task_id, reason: `${action} withheld: ${missing}`, safe: false, preconditions: pre, evidence_kind: row.evidence_kind, source_class: row.class });
    return false;
  }

  for (const row of classification.rows) {
    const t = row.task_id || row.evidence_path;

    switch (row.class) {
      case 'settled': {
        const pr = row.task_id ? prByTask.get(row.task_id) : null;
        if (pr && pr.mergeable === 'MERGEABLE' && !pr.verdict_comment) {
          push({
            action: 'gate-ready', target: row.task_id, safe: true, evidence_kind: row.evidence_kind, source_class: row.class,
            reason: `PR #${pr.number} is mergeable but carries no verdict comment — it is waiting at the gate`,
            preconditions: ['the PR is mergeable', 'no dsv-verdict comment on the PR', 'a reviewer verdict is the next step'],
          });
        }
        if (row.terminal_state) {
          push({
            action: 'reap', target: row.task_id, safe: true, evidence_kind: row.evidence_kind, source_class: row.class,
            reason: `task is settled and its terminal still exists (${row.terminal_state}) — the terminal can be collected`,
            preconditions: ['the task is terminal', 'its terminal still exists', 'nothing is running for it'],
          });
        }
        break;
      }

      case 'idle-finished-unsettled':
        push({
          action: 'nudge', target: row.task_id, safe: true, evidence_kind: row.evidence_kind, source_class: row.class,
          reason: 'the turn ended and no worker_done was sent — ask for the report before collecting anything',
          preconditions: ['the transcript shows the turn ended', 'no worker_done in the transcript'],
        });
        break;

      case 'provider-disconnect': {
        push({
          action: 'nudge', target: row.task_id, safe: true, evidence_kind: row.evidence_kind, source_class: row.class,
          reason: 'the worker is alive but cannot reach the provider — a nudge establishes whether the session is usable',
          preconditions: ['transport errors in the transcript', 'the process is still alive'],
        });
        destructive('abandon', row, ['the worker has not recovered after the nudge']);
        break;
      }

      case 'zombie':
        destructive('abandon', row, ['the terminal no longer exists, so the task can never settle itself']);
        break;

      case 'working-frozen':
        push({
          action: 'escalate', target: row.task_id, safe: false, evidence_kind: 'absence', source_class: row.class,
          reason: `${row.reason} — a frozen counter is a suspect, never proof; escalate only`,
          preconditions: ['two samples at least 90 s apart', 'an identical progress counter', 'a human decides what, if anything, to do'],
        });
        break;

      case 'permission-wait':
        push({
          action: 'escalate', target: row.task_id, safe: false, evidence_kind: row.evidence_kind, source_class: row.class,
          reason: `the worker is waiting for a human answer: ${row.reason}`,
          preconditions: ['a question is on screen', 'answering it is a human decision, not the reconciler\'s'],
        });
        break;

      case 'rate-limited':
        push({
          action: 'escalate', target: row.task_id, safe: false, evidence_kind: row.evidence_kind, source_class: row.class,
          reason: 'provider rate limit — wait it out; a retry attempt is not burned by a rate limit',
          preconditions: ['a rate-limit error is in the transcript', 'do not re-dispatch until the window passes'],
        });
        break;

      case 'orphan-dir':
        push({
          action: 'escalate', target: row.evidence_path, safe: false, evidence_kind: row.evidence_kind, source_class: row.class,
          reason: `directory is not registered as a worktree (${row.reason}) — list it, never delete it`,
          preconditions: ['the pipeline does not own every directory on disk', 'a human decides what it is'],
        });
        break;

      case 'working':
        if (row.evidence_kind === 'absence') {
          push({
            action: 'escalate', target: row.task_id, safe: false, evidence_kind: 'absence', source_class: row.class,
            reason: 'liveness is unverifiable — absence of evidence grants no authority, so say so rather than act',
            preconditions: ['re-derive liveness before drawing any conclusion'],
          });
        } else {
          push({
            action: 'none', target: row.task_id, safe: true, evidence_kind: 'positive', source_class: row.class,
            reason: 'live and no signal contradicts it — leave it alone',
            preconditions: [],
          });
        }
        break;

      default:
        push({ action: 'escalate', target: t, safe: false, evidence_kind: row.evidence_kind || 'absence', source_class: row.class, reason: `no rule for class ${row.class}`, preconditions: ['a class with no rule must not be silently ignored'] });
    }
  }

  // --- spawn: only with a free slot AND an eligible issue. Capacity is D1's answer, not a guess.
  const issues = (opts.issues || snapshot.github.issues || []).filter(i => (i.labels || []).some(l => /^agent$/.test(String(l))));
  const capacity = opts.capacity || null;
  if (capacity && typeof capacity.free_slots === 'number') {
    if (capacity.free_slots > 0 && issues.length) {
      const issue = issues[0];
      push({
        action: 'spawn', target: `issue#${issue.number}`, safe: true, evidence_kind: 'positive', source_class: null,
        reason: `${capacity.free_slots} free slot(s) and issue #${issue.number} is labelled agent — a coder could be started for it`,
        preconditions: ['a free slot exists (D1)', 'the issue carries the agent label', 'no file/area conflict with an open PR', 'the model is not exhausted'],
      });
    } else if (!issues.length) {
      push({ action: 'escalate', target: 'spawn', safe: false, evidence_kind: 'absence', source_class: null, reason: 'no eligible issue (none labelled agent) — nothing to spawn for', preconditions: [] });
    } else {
      push({ action: 'escalate', target: 'spawn', safe: false, evidence_kind: 'absence', source_class: null, reason: `capacity: ${capacity.free_slots} free slot(s) — a queue is state, and state is re-derived`, preconditions: [] });
    }
  } else if (issues.length) {
    push({ action: 'escalate', target: 'spawn', safe: false, evidence_kind: 'absence', source_class: null, reason: `${issues.length} eligible issue(s) but capacity is unknown (D1 has not answered) — no spawn is proposed on a guess`, preconditions: [] });
  }

  const counts = rows.reduce((a, r) => (a[r.action] = (a[r.action] || 0) + 1, a), {});
  const unsafeDestructive = rows.filter(r => DESTRUCTIVE.has(r.action) && !r.safe);
  if (unsafeDestructive.length) notes.push(`${unsafeDestructive.length} destructive row(s) are marked unsafe — they must not be executed`);

  return {
    schema: 'reconcile/1',
    observed_at: classification.observed_at || snapshot.taken_at_utc,
    executes: 'nothing',
    counts,
    rows,
    notes,
  };
}

module.exports = { reconcile, DESTRUCTIVE };

if (require.main === module) {
  const [snapFile, classFile, capFile] = process.argv.slice(2);
  if (!snapFile || !classFile) { console.error('usage: node src/reconcile.js <snapshot.json> <classify.json> [capacity.json]'); process.exit(2); }
  const snapshot = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  const classification = JSON.parse(fs.readFileSync(classFile, 'utf8'));
  const capacity = capFile && fs.existsSync(capFile) ? JSON.parse(fs.readFileSync(capFile, 'utf8')) : null;
  console.log(JSON.stringify(reconcile(snapshot, classification, { capacity }), null, 2));
}
