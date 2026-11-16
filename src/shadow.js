#!/usr/bin/env node
// src/shadow.js — C4: the shadow loop. It observes, classifies, proposes — and does nothing else.
//
// HARD CONSTRAINTS (TASKS.md C4):
//   * NO writes to the pipeline. No orca write verb, no gh write verb, no git write verb. The only
//     things this process writes are its own artefacts: the lock, the heartbeat, the stop file and
//     its daily log.
//   * NO `check --wait` and NO ack. The shadow does not consume the coordinator's mailbox; a message
//     it acked would be a message the coordinator never sees. It observes state, not the queue.
//   * Every command goes through src/guard/exec.js, so the allow list — not this file's good
//     intentions — decides what can run.
//
// Why it exists at all: C1-C3 diagnose and sequence correctly, but nothing was calling them. On
// 2026-09-21 the stuck fixer sat for twenty hours because no watcher was running; this loop is the
// part that would have been running.
//
// Files:
//   state/shadow.lock        single-instance lock (pid + start time); a live pid refuses a second run
//   state/shadow.heartbeat   rewritten every cycle — its mtime is the liveness proof
//   state/shadow.stop        if this file exists, the loop exits cleanly at the next cycle
//   logs/shadow-YYYYMMDD.jsonl   one JSON line per cycle: what it saw, classified, would have done
const fs = require('fs');
const path = require('path');
const guard = require(path.join(__dirname, 'guard', 'exec.js'));

const V2 = path.dirname(__dirname);
const STATE = path.join(V2, 'state');
const LOGS = path.join(V2, 'logs');
const LOCK = path.join(STATE, 'shadow.lock');
const HEARTBEAT = path.join(STATE, 'shadow.heartbeat');
const STOP = path.join(STATE, 'shadow.stop');
// The 72 h window's start, persisted. Measuring it from the PROCESS start means a keepalive restart
// silently resets the clock — the loop would restart at hour 30, see hrs≈0, and never write the 24 h
// checkpoint at all. The window belongs to the run, not to the process.
const WINDOW = path.join(STATE, 'shadow.window');

const argv = process.argv.slice(2);
const ONCE = argv.includes('--once');
const INTERVAL_MS = (() => {
  const i = argv.indexOf('--interval');
  const s = i > -1 ? Number(argv[i + 1]) : 300;
  return (Number.isFinite(s) && s >= 90 ? s : 300) * 1000;   // >= 90 s, per C2's sampling rule
})();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const day = () => nowIso().slice(0, 10).replace(/-/g, '');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Single-instance lock. A stale lock (dead pid) is taken over and said so. */
function takeLock() {
  fs.mkdirSync(STATE, { recursive: true });
  if (fs.existsSync(LOCK)) {
    const prev = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (prev.pid && prev.pid !== process.pid && alive(prev.pid)) {
      console.error(`shadow: another instance is alive (pid ${prev.pid}, started ${prev.started_at}) — refusing to start a second`);
      process.exit(3);
    }
    console.error(`shadow: taking over a stale lock from pid ${prev.pid} (not alive)`);
  }
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, started_at: nowIso() }, null, 2));
}

function releaseLock() {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (cur.pid === process.pid) fs.unlinkSync(LOCK);
  } catch (e) { /* nothing to release */ }
}

/** Run one command through the gate and parse its JSON. A failure is recorded, never thrown. */
function gjson(a, timeout) {
  const r = guard.run(a, { cwd: V2, dryRun: false, timeout: timeout || 180000 });
  if (!r.ok) return { error: r.error || `exit ${r.exit}` };
  try { return { json: JSON.parse(r.stdout) }; } catch (e) { return { error: `not JSON: ${e.message}` }; }
}

/** One observation cycle. Read-only throughout. */
function cycle(n) {
  const at = nowIso();
  // Two heartbeats per cycle: one at the start and one at the end. A single end-of-cycle heartbeat
  // cannot tell a slow cycle from a wedged one, and the watchdog needs exactly that distinction — it
  // reported "healthy" while the process stood still for seven minutes, because the pid was alive.
  try { fs.writeFileSync(HEARTBEAT, `${at} cycle=${n} phase=start\n`); } catch (e) { /* state dir missing */ }
  const entry = { n, at, ok: false, errors: [], snapshot: null, classify: null, reconcile: null, real: null };

  // A cycle must be bounded by something a watchdog can reason about. 900 s turned a fast failure
  // into a fifteen-minute blind hang — measured: the process was alive, the heartbeat stood still for
  // seven minutes, and the keepalive saw a healthy pid. 300 s is enough for every step on a loaded
  // machine and short enough that a wedged cycle is visible within one watchdog interval.
  const snap = gjson(['node', 'src/snapshot.js', '--stdout'], 300000);
  if (snap.error) { entry.errors.push(`snapshot: ${snap.error}`); return entry; }
  const S = snap.json;
  entry.snapshot = {
    tasks: S.orca.tasks.length,
    dispatched: S.orca.dispatches.length,
    terminals: S.orca.terminals.length,
    prs: S.github.prs.length,
    orphans: S.host.orphan_dirs.length,
    errors: S.errors.length,
    c_free: S.host.disk && S.host.disk.c ? S.host.disk.c.avail : null,
    ram_free_mb: S.host.ram ? S.host.ram.free_mb : null,
  };
  entry.errors.push(...S.errors.map(e => `snapshot step ${e.step}: ${String(e.error).slice(0, 120)}`));

  // Classification needs screens; the shadow reads the screens of ACTIVE agent terminals only, which
  // is the cheapest read that can still tell a working worker from a stuck one.
  const screens = {};
  for (const d of S.orca.dispatches) {
    if (!d.assignee_handle) continue;
    const r = guard.run(['orca', 'terminal', 'read', '--terminal', d.assignee_handle, '--screen'],
      { cwd: V2, dryRun: false, timeout: 30000 });
    if (r.ok && r.stdout) screens[d.assignee_handle] = String(r.stdout);
  }
  entry.screens_read = Object.keys(screens).length;

  const { classify } = require(path.join(V2, 'src', 'classify.js'));
  const C = classify(S, { screens });
  entry.classify = { counts: C.counts, inbox: C.inbox.length, network_event: C.network_event ? C.network_event.event_id : null };

  const { reconcile } = require(path.join(V2, 'src', 'reconcile.js'));
  // Capacity is D1's answer and D1 does not exist yet, so the shadow passes nothing and the reconciler
  // says "capacity unknown" rather than guessing. That is the honest state of the system today.
  const R = reconcile(S, C, {});
  entry.reconcile = {
    counts: R.counts,
    // Only the rows that would CHANGE something are logged in full; `none`/`escalate` rows are counted.
    would_do: R.rows.filter(r => r.action !== 'none').map(r => ({ action: r.action, target: r.target, safe: r.safe, evidence_kind: r.evidence_kind, reason: r.reason.slice(0, 160) })),
  };

  // The REAL state, recorded so the accuracy report can compare "would do" with "what happened".
  entry.real = {
    prs: S.github.prs.map(p => ({ n: p.number, mergeable: p.mergeable, verdict: p.verdict_comment, checks: p.checks_state })),
    tasks: S.orca.tasks.filter(t => !['completed', 'cancelled', 'archived'].includes(String(t.status)))
      .map(t => ({ id: t.id, status: t.status, title: (t.title || '').slice(0, 60) })),
  };

  entry.ok = true;
  return entry;
}

function appendLog(entry) {
  fs.mkdirSync(LOGS, { recursive: true });
  fs.appendFileSync(path.join(LOGS, `shadow-${day()}.jsonl`), JSON.stringify(entry) + '\n');
}

/** A compact checkpoint at each 24 h mark, so the report has raw material without re-reading days of log. */
function checkpoint(n) {
  // Read EVERY daily log, not just today's. A 72 h window spans three files (shadow-YYYYMMDD.jsonl),
  // so a checkpoint that opened only today's would silently lose two thirds of its own evidence — and
  // the loss would be invisible, because the numbers it printed would still look plausible.
  const files = fs.readdirSync(LOGS).filter(f => /^shadow-\d{8}\.jsonl$/.test(f)).sort();
  const entries = [];
  for (const f of files) {
    for (const l of fs.readFileSync(path.join(LOGS, f), 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { entries.push(JSON.parse(l)); } catch (e) { /* a torn last line during a write */ }
    }
  }
  const ok = entries.filter(e => e.ok);
  const first = ok[0], last = ok[ok.length - 1];

  // COVERAGE, not just cycle count. A window can be 72 h long while the loop was only awake for part
  // of it — a powered-off machine leaves no observations, and an incident inside that hole is exactly
  // what this loop exists to catch (2026-09-21 happened while nothing was running). The longest gap
  // between consecutive observations is the honest measure of what the window actually covered.
  let maxGapMin = 0;
  for (let i = 1; i < ok.length; i++) {
    const a = Date.parse(ok[i - 1].at), b = Date.parse(ok[i].at);
    if (Number.isFinite(a) && Number.isFinite(b)) maxGapMin = Math.max(maxGapMin, (b - a) / 60000);
  }
  const windowHours = first && last ? (Date.parse(last.at) - Date.parse(first.at)) / 3600000 : 0;

  // DEGRADED SAMPLING, separate from gaps. The loop can miss no cycle at all and still sample far
  // coarser than normal — measured during D2 work: cycle 6 -> 7 took 21.5 minutes against a normal
  // cadence of about 6. That is not a gap (nothing was skipped) and it is not covered by
  // longest_gap_minutes (which measures silence, not slowness), so it gets its own category.
  const NOMINAL_MIN = 7;                 // interval 300 s + a ~60-90 s cycle
  const DEGRADED_FACTOR = 2;             // slower than twice nominal counts as degraded
  let degradedMin = 0;
  const degradedWindows = [];
  for (let i = 1; i < ok.length; i++) {
    const a = Date.parse(ok[i - 1].at), b = Date.parse(ok[i].at);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const mins = (b - a) / 60000;
    if (mins > NOMINAL_MIN * DEGRADED_FACTOR) {
      degradedMin += mins;
      degradedWindows.push({ from: ok[i - 1].at, to: ok[i].at, minutes: Number(mins.toFixed(1)) });
    }
  }

  const counts = {};
  for (const e of ok) for (const r of ((e.reconcile && e.reconcile.would_do) || [])) counts[r.action] = (counts[r.action] || 0) + 1;
  const out = {
    generated_at: nowIso(),
    window_started_at: fs.existsSync(WINDOW) ? fs.readFileSync(WINDOW, 'utf8').trim() : null,
    log_files: files,
    cycles_total: entries.length,
    cycles_ok: ok.length,
    cycles_failed: entries.length - ok.length,
    first_cycle_at: first ? first.at : null,
    last_cycle_at: last ? last.at : null,
    covered_hours: Number(windowHours.toFixed(2)),
    longest_gap_minutes: Number(maxGapMin.toFixed(1)),
    degraded_sampling_minutes: Number(degradedMin.toFixed(1)),
    degraded_windows: degradedWindows,
    coverage_note: 'covered_hours is observation span; longest_gap_minutes is the largest silence in it; degraded_sampling_minutes is time sampled coarser than 2x nominal without missing a cycle. An incident inside a gap was not observed at all; an incident inside a degraded window was observed, but later than normal.',
    would_do_totals: counts,
    cycles_with_provider_disconnect: ok.filter(e => (e.classify && e.classify.counts['provider-disconnect'] || 0) > 0).length,
    note: 'raw material for the accuracy report; the report itself is written by the coordinator',
  };
  const p = path.join(LOGS, `shadow-checkpoint-${n}h.json`);
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log(`shadow: checkpoint written ${p} (${files.length} log file(s), ${entries.length} cycle(s))`);
}

async function main() {
  takeLock();
  fs.mkdirSync(STATE, { recursive: true });
  // The window start is written once and never moved by a restart: the 24 h and 72 h marks belong to
  // the RUN, so a keepalive restart at hour 30 must still find the 24 h mark behind it.
  if (!fs.existsSync(WINDOW)) {
    fs.writeFileSync(WINDOW, nowIso() + '\n');
    console.log(`shadow: window started at ${nowIso()}`);
  }
  const windowStart = Date.parse(fs.readFileSync(WINDOW, 'utf8').trim()) || Date.now();
  // Cycle numbers continue across restarts, so the log reads as one run rather than two interleaved
  // ones — the earlier version restarted at n=1 and the log showed 1,2,1,2.
  let n = 0;
  try {
    const files = fs.readdirSync(LOGS).filter(f => /^shadow-\d{8}\.jsonl$/.test(f)).sort();
    for (const f of files) {
      for (const l of fs.readFileSync(path.join(LOGS, f), 'utf8').split('\n')) {
        if (l.trim()) { try { n = Math.max(n, JSON.parse(l).n || 0); } catch (e) { /* torn line */ } }
      }
    }
  } catch (e) { /* first run: no logs yet */ }
  let lastCheckpoint = 0;
  try { if (fs.existsSync(path.join(LOGS, 'shadow-checkpoint-24h.json'))) lastCheckpoint = 24; } catch (e) {}
  console.log(`shadow: started pid ${process.pid} at ${nowIso()} (interval ${INTERVAL_MS / 1000}s, window began ${new Date(windowStart).toISOString().replace(/\.\d+Z$/, 'Z')}, resuming at cycle ${n + 1})`);
  try {
    do {
      if (fs.existsSync(STOP)) { console.log(`shadow: stop file present (${STOP}) — exiting cleanly`); break; }
      n += 1;
      let entry;
      try { entry = cycle(n); }
      catch (e) { entry = { n, at: nowIso(), ok: false, errors: [`cycle threw: ${e.message}`] }; }
      appendLog(entry);
      fs.writeFileSync(HEARTBEAT, `${entry.at} cycle=${n} ok=${entry.ok}\n`);
      const hrs = (Date.now() - windowStart) / 3600000;
      if (hrs >= 24 && lastCheckpoint < 24) { checkpoint(24); lastCheckpoint = 24; }
      if (hrs >= 72 && lastCheckpoint < 72) { checkpoint(72); lastCheckpoint = 72; }
      if (n % 12 === 1 || !entry.ok) {
        console.log(`shadow: cycle ${n} at ${entry.at} ok=${entry.ok} dispatched=${entry.snapshot ? entry.snapshot.dispatched : '-'} would_do=${entry.reconcile ? JSON.stringify(entry.reconcile.counts) : '-'}`);
      }
      if (ONCE) break;
      await sleep(INTERVAL_MS);
    } while (true);
  } finally {
    releaseLock();
  }
  console.log(`shadow: stopped at ${nowIso()} after ${n} cycle(s)`);
}

main();
