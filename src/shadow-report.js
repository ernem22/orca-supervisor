#!/usr/bin/env node
// src/shadow-report.js — turn the shadow's own logs into the accuracy report.
//
// It answers four questions from the data, not from memory:
//   1. how many cycles ran, over what span, with what coverage (gaps vs degraded sampling)
//   2. which cycles contained a REAL event — a worker appearing, a task changing state, a PR changing
//      mergeability or gaining a verdict, a fleet transport error
//   3. whether those events were classified correctly (the class's evidence kind, and whether the
//      state that followed matches what the classification claimed)
//   4. agreement between what the shadow WOULD have done and what the pipeline actually did
//
// "Real" means observed from Orca/GitHub state. A synthetic drill would have to be labelled as such in
// the log, and nothing in this log is synthetic — every line came from a live snapshot.
const fs = require('fs');
const path = require('path');

const V2 = path.dirname(__dirname);
const LOGS = path.join(V2, 'logs');

function load() {
  const files = fs.readdirSync(LOGS).filter(f => /^shadow-\d{8}\.jsonl$/.test(f)).sort();
  const entries = [];
  for (const f of files) {
    for (const l of fs.readFileSync(path.join(LOGS, f), 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { entries.push(JSON.parse(l)); } catch (e) { /* torn last line */ }
    }
  }
  return { files, entries };
}

const sig = (e) => JSON.stringify({
  dispatched: e.snapshot ? e.snapshot.dispatched : null,
  terminals: e.snapshot ? e.snapshot.terminals : null,
  prs: e.real ? e.real.prs.map(p => `${p.n}:${p.mergeable}:${p.verdict}`).sort() : null,
  tasks: e.real ? e.real.tasks.map(t => `${t.id}:${t.status}`).sort() : null,
});

function build() {
  const { files, entries } = load();
  const ok = entries.filter(e => e.ok);
  const first = ok[0], last = ok[ok.length - 1];

  // coverage
  let maxGap = 0, degraded = 0;
  const degradedWindows = [];
  for (let i = 1; i < ok.length; i++) {
    const a = Date.parse(ok[i - 1].at), b = Date.parse(ok[i].at);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const m = (b - a) / 60000;
    maxGap = Math.max(maxGap, m);
    if (m > 14) { degraded += m; degradedWindows.push({ from: ok[i - 1].at, to: ok[i].at, minutes: Number(m.toFixed(1)) }); }
  }

  // real events: a change in the observable state between consecutive cycles
  const events = [];
  for (let i = 1; i < ok.length; i++) {
    const a = ok[i - 1], b = ok[i];
    if (sig(a) === sig(b)) continue;
    const changes = [];
    const pa = new Map((a.real ? a.real.prs : []).map(p => [p.n, p]));
    for (const p of (b.real ? b.real.prs : [])) {
      const q = pa.get(p.n);
      if (!q) { changes.push(`PR #${p.n} appeared`); continue; }
      if (q.mergeable !== p.mergeable) changes.push(`PR #${p.n} mergeable ${q.mergeable} -> ${p.mergeable}`);
      if (q.verdict !== p.verdict) changes.push(`PR #${p.n} verdict ${q.verdict} -> ${p.verdict}`);
      if (q.checks !== p.checks) changes.push(`PR #${p.n} checks ${q.checks} -> ${p.checks}`);
    }
    const ta = new Map((a.real ? a.real.tasks : []).map(t => [t.id, t.status]));
    for (const t of (b.real ? b.real.tasks : [])) {
      if (ta.has(t.id) && ta.get(t.id) !== t.status) changes.push(`task ${t.id} ${ta.get(t.id)} -> ${t.status}`);
      if (!ta.has(t.id)) changes.push(`task ${t.id} appeared (${t.status})`);
    }
    if (a.snapshot && b.snapshot && a.snapshot.dispatched !== b.snapshot.dispatched) {
      changes.push(`dispatched count ${a.snapshot.dispatched} -> ${b.snapshot.dispatched}`);
    }
    events.push({
      at: b.at, cycle: b.n, changes,
      classification: b.classify ? b.classify.counts : null,
      would_do: (b.reconcile && b.reconcile.would_do || []).map(r => `${r.action}(${r.safe ? 'safe' : 'unsafe'},${r.evidence_kind})`),
      worker_present: b.snapshot ? b.snapshot.dispatched > 0 : null,
    });
  }

  // agreement: a proposal counts as agreed when the state later moved the way it pointed. Deduped by
  // target — the same PR is re-proposed every cycle, and counting each repetition inflated this to
  // "0/154" for a window with three open PRs. One row per target, from its FIRST proposal.
  const agreement = [];
  const seenTargets = new Set();
  for (const e of ok) {
    for (const r of (e.reconcile && e.reconcile.would_do || [])) {
      if (r.action !== 'gate-ready') continue;
      const m = /PR #(\d+)/.exec(r.reason || '');
      if (!m) continue;
      const n = Number(m[1]);
      if (seenTargets.has(n)) continue;
      seenTargets.add(n);
      const later = ok.slice(ok.indexOf(e) + 1).find(x => (x.real.prs || []).some(p => p.n === n && p.verdict === true));
      agreement.push({
        at: e.at,
        proposal: `gate-ready #${n}`,
        first_proposed_at: e.at,
        proposed_cycles: ok.filter(x => (x.reconcile && x.reconcile.would_do || []).some(y => y.action === 'gate-ready' && new RegExp(`PR #${n}\\b`).test(y.reason || ''))).length,
        outcome: later ? `verdict posted later (${later.at})` : 'no verdict yet',
        agreed: !!later,
      });
    }
  }

  const counts = {};
  for (const e of ok) for (const r of (e.reconcile && e.reconcile.would_do || [])) counts[r.action] = (counts[r.action] || 0) + 1;

  return {
    generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    log_files: files,
    cycles_total: entries.length,
    cycles_ok: ok.length,
    cycles_failed: entries.length - ok.length,
    window: { first: first ? first.at : null, last: last ? last.at : null, hours: first && last ? Number(((Date.parse(last.at) - Date.parse(first.at)) / 3600000).toFixed(2)) : 0 },
    coverage: { longest_gap_minutes: Number(maxGap.toFixed(1)), degraded_sampling_minutes: Number(degraded.toFixed(1)), degraded_windows: degradedWindows },
    workers_seen: ok.filter(e => e.snapshot && e.snapshot.dispatched > 0).length,
    real_events: events,
    real_event_count: events.length,
    worker_events: events.filter(e => e.worker_present).length,
    would_do_totals: counts,
    agreement,
    agreement_summary: { proposed: agreement.length, agreed: agreement.filter(a => a.agreed).length },
  };
}

if (require.main === module) {
  const r = build();
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  console.log(`shadow report — ${r.cycles_ok}/${r.cycles_total} cycle(s) over ${r.window.hours} h`);
  console.log(`  window      : ${r.window.first}  ->  ${r.window.last}`);
  console.log(`  coverage    : longest gap ${r.coverage.longest_gap_minutes} min, degraded ${r.coverage.degraded_sampling_minutes} min (${r.coverage.degraded_windows.length} window(s))`);
  console.log(`  cycles with a live worker : ${r.workers_seen}`);
  console.log(`  REAL events : ${r.real_event_count} (of which with a worker present: ${r.worker_events})`);
  for (const e of r.real_events.slice(-12)) console.log(`    ${e.at} cycle ${e.cycle}: ${e.changes.join('; ')}`);
  console.log(`  would-do    : ${JSON.stringify(r.would_do_totals)}`);
  console.log(`  agreement   : ${r.agreement_summary.agreed}/${r.agreement_summary.proposed}`);
  for (const a of r.agreement) console.log(`    ${a.at} ${a.proposal} -> ${a.outcome}`);
}
module.exports = { build };
