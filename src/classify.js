#!/usr/bin/env node
// src/classify.js — C2: classify each task/dispatch from a snapshot, with the evidence it rests on.
//
// THE PRINCIPLE, and the reason this file is shaped the way it is:
//   No destructive-action proposal without POSITIVE evidence.
//   Positive evidence = `exited` liveness; the worker's own process-exit observation; a transcript
//   whose last turn ended without `worker_done`.
//   `unverifiable` is ABSENCE, and absence grants NO stop/abandon/retry/release authority.
// Every classification therefore carries `evidence_kind`, and anything derived from an unverifiable
// liveness is marked `absence` so C3 can refuse to act on it.
//
// `working-frozen` is a SUSPECT class and nothing more. Its only output is an inbox item
// (`stall-suspected`) plus the evidence path. It never proposes a destructive action — the old
// pipeline rule ("frozen counter = definite stall, abandon") contradicts the Orca guide's principle,
// and that conflict is stated in the report rather than resolved in code.
//
// Sampling is by TIMESTAMP, never by loop count: two observations at least MIN_SAMPLE_MS apart, with
// the same progress counter, are what make a stall suspect. Two samples taken 200 ms apart prove
// nothing and are not allowed to.
const fs = require('fs');
const path = require('path');
const opencode = require(path.join(__dirname, '..', 'adapters', 'opencode.js'));

const MIN_SAMPLE_MS = 90 * 1000;

const CLASSES = [
  'working', 'working-frozen', 'idle-finished-unsettled', 'provider-disconnect',
  'permission-wait', 'rate-limited', 'settled', 'zombie', 'orphan-dir',
];

const TERMINAL_TASK_STATES = new Set(['completed', 'cancelled', 'archived']);

function ms(iso) { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; }

/**
 * Classify one snapshot.
 * @param snapshot  a document from src/snapshot.js
 * @param opts.screens   { [handle]: "<terminal screen text>" }
 * @param opts.previous  a previous result of this function (for the >=90 s frozen test)
 * @param opts.now       ISO timestamp of this observation (defaults to snapshot.taken_at_utc)
 */
function classify(snapshot, opts = {}) {
  const screens = opts.screens || {};
  const now = ms(opts.now || snapshot.taken_at_utc) || Date.now();
  const prevByTask = new Map(((opts.previous && opts.previous.rows) || []).map(r => [r.task_id, r]));

  const rows = [];
  const inbox = [];
  const notes = [];

  const terminals = new Map(snapshot.orca.terminals.map(t => [t.handle, t]));
  const dispatches = new Map(snapshot.orca.dispatches.map(d => [d.task_id, d]));

  // --- the network-event rule: connection errors on >= 2 agents in the same window are ONE event,
  // not N coincidences, and a retry attempt is not burned by it.
  const transport = [];
  for (const d of snapshot.orca.dispatches) {
    const screen = d.assignee_handle ? screens[d.assignee_handle] : null;
    if (!screen) continue;
    const errs = opencode.errors(screen).filter(e => e.kind === 'transport');
    if (errs.length) transport.push({ task_id: d.task_id, handle: d.assignee_handle, count: errs.reduce((a, e) => a + e.count, 0) });
  }
  const networkEvent = transport.length >= 2
    ? { event_id: `net-${now}`, kind: 'network-event', agents: transport.map(t => t.handle), evidence: 'transport errors on >= 2 agents in the same window' }
    : null;
  if (networkEvent) notes.push('network drop is not a rate limit: one event covers all affected agents, and retries are not burned');

  // --- one row per open task
  for (const t of (snapshot.derived.task_terminal_pr_table || [])) {
    const d = dispatches.get(t.task_id) || null;
    const term = t.terminal ? terminals.get(t.terminal.handle) || null : null;
    const screen = t.assignee_handle ? screens[t.assignee_handle] : null;
    const sig = screen ? opencode.read(screen) : null;

    const row = {
      task_id: t.task_id,
      task_title: t.task_title,
      task_status: t.task_status,
      handle: t.assignee_handle,
      terminal_state: term ? term.state : (t.terminal ? t.terminal.state : null),
      liveness: d ? d.liveness : null,
      // The counter must be carried on the row, because the frozen test compares THIS observation's
      // counter with the previous one's. Without it every comparison is undefined === undefined, the
      // class becomes unreachable, and the suite fails on a fixture that cannot exist.
      counter: sig && sig.counter ? sig.counter.raw : null,
      observed_at: new Date(now).toISOString().replace(/\.\d+Z$/, 'Z'),
      class: null,
      evidence_kind: 'absence',
      reason: null,
      evidence_path: null,
      suspect_only: false,
      network_event: networkEvent ? networkEvent.event_id : null,
    };

    if (TERMINAL_TASK_STATES.has(String(t.task_status))) {
      row.class = 'settled'; row.evidence_kind = 'positive';
      row.reason = `task status is ${t.task_status} — nothing is running for it`;
      rows.push(row); continue;
    }

    if (!d) {
      // A task that is open but not dispatched has no worker. Not a zombie: there is nothing to kill.
      row.class = 'settled'; row.evidence_kind = 'positive';
      row.reason = `task is ${t.task_status} and not dispatched — no worker exists for it`;
      rows.push(row); continue;
    }

    // A dispatched task whose terminal is gone is a zombie: the task believes work is happening.
    if (!term) {
      row.class = 'zombie'; row.evidence_kind = 'positive';
      row.reason = 'task is dispatched but its terminal no longer exists — nothing can settle it';
      rows.push(row); continue;
    }

    if (d.liveness === 'exited') {
      row.class = 'settled'; row.evidence_kind = 'positive';
      row.reason = 'projection liveness is exited — the worker is gone and the task can be settled';
      rows.push(row); continue;
    }

    // From here the worker looks alive. Screens decide between the remaining classes.
    if (sig) {
      if (sig.worker_done) {
        row.class = 'settled'; row.evidence_kind = 'positive';
        row.reason = 'the transcript carries worker_done — the worker reported its own completion';
        rows.push(row); continue;
      }
      // A BLOCKING prompt outranks a past error. A screen can carry both — the sandbox drill produced
      // exactly that (an injected transport error still on screen while a real permission prompt held the
      // worker). The prompt is the worker's CURRENT state: it cannot proceed until a human answers. The
      // error line is an event that may be minutes old and already recovered from. Ordering them the
      // other way reported a blocked worker as merely disconnected, and proposed a nudge it could not act on.
      if (sig.permission_question) {
        row.class = 'permission-wait'; row.evidence_kind = 'positive';
        row.reason = `screen shows a blocking prompt awaiting a human: ${String(sig.permission_question).slice(0, 90)}`;
        row.evidence_path = `screens/${row.handle}.txt`;
        rows.push(row); continue;
      }
      const rate = sig.errors.find(e => e.kind === 'rate_limit');
      if (rate) {
        row.class = 'rate-limited'; row.evidence_kind = 'positive';
        row.reason = `screen shows a rate-limit error (${rate.first} x${rate.count})`;
        row.evidence_path = `screens/${row.handle}.txt`;
        rows.push(row); continue;
      }
      const transportErr = sig.errors.find(e => e.kind === 'transport');
      if (transportErr) {
        row.class = 'provider-disconnect'; row.evidence_kind = 'positive';
        row.reason = `screen shows a transport failure (${transportErr.first} x${transportErr.count}); the worker is alive but cannot reach the provider`
          + (networkEvent ? ' — part of one network event' : '');
        row.evidence_path = `screens/${row.handle}.txt`;
        rows.push(row); continue;
      }
      if (sig.turn.ended) {
        row.class = 'idle-finished-unsettled'; row.evidence_kind = 'positive';
        row.reason = 'the turn ended (idle bar, no timer) and no worker_done was sent — positive evidence, the transcript says so itself';
        row.evidence_path = `screens/${row.handle}.txt`;
        rows.push(row); continue;
      }
    }

    // Frozen is only a SUSPECT, and only when two samples are far enough apart to mean anything.
    const prev = prevByTask.get(t.task_id) || null;
    // The sampling timestamp can come from the row or from the previous RESULT — an earlier version
    // read only the row, which never carried it, so every comparison looked "too close" and the class
    // was unreachable in exactly the case it exists for.
    const prevAt = prev
      ? (prev.observed_at ? ms(prev.observed_at) : ms(opts.previous && opts.previous.observed_at))
      : null;
    const sameCounter = !!(prev && prev.counter && sig && sig.counter && prev.counter === sig.counter.raw);
    const farApart = prevAt != null && (now - prevAt) >= MIN_SAMPLE_MS;
    if (sameCounter && farApart && d.liveness === 'live') {
      row.class = 'working-frozen'; row.evidence_kind = 'absence'; row.suspect_only = true;
      row.reason = `the progress counter is unchanged (${sig.counter.raw}) across two samples ${Math.round((now - prevAt) / 1000)} s apart — SUSPECT, not proof`;
      row.evidence_path = `screens/${row.handle}.txt`;
      inbox.push({ type: 'stall-suspected', task_id: t.task_id, handle: row.handle, since: prev.observed_at, evidence_path: row.evidence_path, note: 'no destructive action is proposed; escalate only' });
      rows.push(row); continue;
    }
    if (sameCounter && !farApart) {
      notes.push(`task ${t.task_id}: identical counter but the samples are closer than ${MIN_SAMPLE_MS / 1000} s apart — not evidence of anything, so it is not called frozen`);
    }

    if (d.liveness === 'live') {
      row.class = 'working'; row.evidence_kind = 'positive';
      row.reason = 'projection liveness is live and no terminal signal contradicts it';
    } else {
      // unverifiable / unknown: absence. Say so rather than guess a class.
      row.class = 'working'; row.evidence_kind = 'absence';
      row.reason = `liveness is ${d.liveness || 'unknown'} — absence of evidence, not evidence of work; no authority follows from this row`;
    }
    rows.push(row);
  }

  // --- orphan directories are their own class, from the snapshot's set difference.
  for (const o of (snapshot.host.orphan_dirs || [])) {
    rows.push({
      task_id: null, task_title: null, task_status: null, handle: null, terminal_state: null,
      liveness: null, class: 'orphan-dir', evidence_kind: 'positive',
      reason: `directory exists on disk but Orca does not register it as a worktree (${Math.round(o.size_bytes / 1048576)} MB)`,
      evidence_path: o.path, suspect_only: false, network_event: null,
    });
  }

  const counts = rows.reduce((a, r) => (a[r.class] = (a[r.class] || 0) + 1, a), {});
  return {
    schema: 'classify/1',
    observed_at: new Date(now).toISOString().replace(/\.\d+Z$/, 'Z'),
    min_sample_ms: MIN_SAMPLE_MS,
    network_event: networkEvent,
    counts,
    rows,
    inbox,
    notes,
  };
}

module.exports = { classify, CLASSES, MIN_SAMPLE_MS, TERMINAL_TASK_STATES };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node src/classify.js <snapshot.json> [previous-classify.json]'); process.exit(2); }
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const prev = process.argv[3] && fs.existsSync(process.argv[3]) ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : null;
  const r = classify(snap, { previous: prev });
  console.log(JSON.stringify(r, null, 2));
}
