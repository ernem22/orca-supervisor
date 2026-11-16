# Shadow window — CLOSED. Verdict: EMPTY WINDOW, not passed validation.

**Closed at 2026-09-24T13:19:02Z, shortened on the coordinator's decision. This is not "72 h complete".**
The label matters more than the length: the loop did what it was built to do, and the thing the window
existed to measure never occurred, because nothing occurred to measure.

## What the window actually contained

```
cycles            24 ok / 25 total        (the one failure was the pre-fix 180 s snapshot timeout)
window            2026-09-24T10:31:14Z -> 2026-09-24T13:19:02Z   = 2.69 h
coverage          longest gap 21.6 min = degraded sampling 21.6 min (one window, correctly logged)
cycles with a live worker   0
REAL events                 0
stall-suspected inbox items 0        provider-disconnect 0        network events 0
PRs seen, unchanged throughout   #126 MERGEABLE · #93 MERGEABLE · #92 CONFLICTING   (all verdict=null)
open tasks, unchanged            24        dispatched: 0
would-do totals   gate-ready 168 · escalate 768
agreement         gate-ready #93 -> no verdict yet (0/1)
```

## Validated by this window

- **The loop's mechanics.** 24 clean cycles, a single-instance lock that refused a second instance
  (exit 3, seen in the keepalive log), a heartbeat that advanced every cycle, a daily log, a stop file
  that produced a clean exit, and a window timestamp that survived three restarts without resetting.
- **The watchdog.** A deliberate drill killed the loop mid-run; the keepalive detected the dead pid,
  restarted it, and stayed silent when healthy. A second drill exposed a real blindness — a live pid
  with a frozen heartbeat reported as "healthy" — and that is fixed: liveness is now the heartbeat's
  freshness, and the pid is only used to clean up a wedged process.
- **Zero false positives on loop behaviour itself.** The reading never oscillated: the same 7 gate-ready
  and 32 escalate rows, cycle after cycle. A detector that invents events would have shown up here.
- **One degraded window, honestly logged.** 21.6 minutes against a ~6 minute nominal cadence, caused by
  the coordinator's own D2 work loading the machine. Recorded as `degraded_sampling_minutes`, separate
  from gaps, with the distinction stated: a gap is not observed at all; a degraded window is observed
  late.

## NOT validated by this window

**Worker-event classification was never exercised.** `classify.js` and `reconcile.js` never saw a real
worker in this window — not a settle, not a stall, not a provider-disconnect, not a zombie, not a
permission wait. Every classification they produced was about tasks with no worker attached. The tests
that cover those classes pass against fixtures; fixtures are not events.

Why: **the pipeline was dormant.** Its newest task is from 2026-09-21 12:23:01 — three days before the
window opened — and `dispatched` was 0 in every one of the 25 cycles. There was no worker to classify,
so no amount of waiting would have produced one. **This is an empty window, not a passed validation.**

## Where the real validation happens (deferred, deliberately)

Real validation of `classify.js` / `reconcile.js` against **actual worker events** is deferred to
**E1's sandbox scenarios 1–8 and 10**. Those generate real dispatches under controlled conditions — a
worker that finishes without `worker_done`, a fake network error, a permission wait, a full-capacity
refusal, managed spawn with two concurrent workers, and the deny-pattern probes.

This is not a gap left open. It is a better validation path than passive waiting: the sandbox produces
the events on purpose, labels them, and can repeat them, whereas the dormant pipeline produced none and
could not be asked to.

## D1 — flagged, not started

D1 measures live agent count, free RAM, free disk, free ports → `SLOTS`, and then (with approval) the
under-load figures: RSS per agent and the peak during `npm ci`.

**The static half is measurable right now and is already in this window's data** — free RAM swung
between 269 MB and 1212 MB, and C: between 1.5 GB and 2.0 GB free, recorded per cycle in
`logs/shadow-*.jsonl`. **The under-load half is not measurable on an idle machine**: RSS per agent
needs an agent, and the `npm ci` peak needs a build. Producing those numbers from a machine with zero
workers would be inventing them.

The honest sequencing: **D1's under-load numbers should be collected during E1's sandbox scenarios**,
which will run one worker (the sandbox limit is one while live workers run) and can run an `npm ci` in
the sandbox. That gives D1 real figures at the cost of no extra load and no extra experiment.

## Artefacts

```
state/shadow.window              the window's start, survived three restarts
state/shadow.stop                the stop file, with who stopped it and why
state/shadow-report-final.json   the machine-readable report
logs/shadow-YYYYMMDD.jsonl       one JSON line per cycle, the raw evidence
logs/shadow-keepalive.log        every keepalive tick and exit
src/shadow.js · src/shadow-report.js
docs/decision-table.md · docs/snapshot-schema.md
```
