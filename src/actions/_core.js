#!/usr/bin/env node
// src/actions/_core.js — E1's shared machinery for the four action executors.
//
// DEFAULT OFF, and off in three independent ways:
//   1. nothing acts unless the caller passes --apply (dry run is the default);
//   2. a kill-switch file (state/actions.disabled) makes every executor refuse, whatever the flags;
//   3. the actual write verbs are denied by src/guard/exec.js until cutover adds them to its allow
//      list — so an --apply run today is audited as a denial rather than silently succeeding.
//
// The executors are the LAST layer of the chain (snapshot -> classify -> reconcile -> act) and the
// only one that changes the world. Everything above it can be wrong harmlessly; this cannot.
//
// The existing spawn.sh / reap.sh are NOT called. Their logic is re-implemented here so the new layer
// owns its own behaviour instead of inheriting a script that was written for a different pipeline.
//
// Guarantees each executor gets from this core:
//   * a precondition check that must pass before anything is attempted;
//   * idempotence — it asks whether the effect already holds and does nothing if it does;
//   * one action per cycle, enforced by a cycle token on disk;
//   * an audit line for EVERY decision, including refusals and dry runs (logs/actions.jsonl);
//   * ONE shape for a refusal: `reason` is always an array of strings, whatever refused. A caller that
//     has to ask "is this a string or a list?" will eventually guess wrong — measured: a test filtering
//     the reason crashed with "(r.reason || []).filter is not a function" when a sibling process's kill
//     switch sent the code down that path.
const fs = require('fs');
const path = require('path');
const guard = require(path.join(__dirname, '..', 'guard', 'exec.js'));

const V2 = path.dirname(path.dirname(__dirname));
// Tests must be able to drive the executors without touching the real state directory. Two test files
// run in parallel processes, and a shared kill switch or cycle token is a race that was measured, not
// theorised: the capacity test once saw another file's kill switch and read a string where it expected
// a list. A caller that sets SUP_V2_STATE_DIR gets its own state directory, and that now covers the kill
// switch and the cycle token as well as the audit log. Nothing in the live system sets it.
const STATE_DIR = process.env.SUP_V2_STATE_DIR || V2;
const KILL_SWITCH = path.join(STATE_DIR, 'state', 'actions.disabled');
const CYCLE_FILE = path.join(STATE_DIR, 'state', 'actions.cycle.json');
const AUDIT = path.join(STATE_DIR, 'logs', 'actions.jsonl');

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function audit(entry) {
  fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
  fs.appendFileSync(AUDIT, JSON.stringify({ ts: nowIso(), ...entry }) + '\n');
}

function killSwitchOn() { return fs.existsSync(KILL_SWITCH); }

function cycleTaken(cycle) {
  if (!cycle) return null;
  try {
    const j = JSON.parse(fs.readFileSync(CYCLE_FILE, 'utf8'));
    return j.cycle === cycle ? j : null;
  } catch (e) { return null; }
}

function markCycle(cycle, action, target) {
  if (!cycle) return;
  fs.mkdirSync(path.dirname(CYCLE_FILE), { recursive: true });
  fs.writeFileSync(CYCLE_FILE, JSON.stringify({ cycle, action, target, at: nowIso() }, null, 2));
}

/**
 * Build one executor.
 * @param def.name          action name (nudge|abandon|reap|spawn)
 * @param def.preconditions (spec, ctx) => string[]   — empty array means "may proceed"
 * @param def.alreadyDone   (spec, ctx) => boolean    — idempotence
 * @param def.argv          (spec, ctx) => string[]   — the command to run, through the gate
 * @param def.describe      (spec, ctx) => string     — what would happen, for the dry-run line
 * @param def.classify      (spec, ctx) => 'supervised'|'external'  — which class this target is
 */
function makeExecutor(def) {
  function run(spec, opts = {}) {
    const cycle = opts.cycle || spec.cycle || null;
    const base = { action: def.name, target: spec.dispatch_id || spec.task_id || spec.target || null, cycle, dry_run: !opts.apply };

    if (killSwitchOn()) {
      audit({ ...base, decision: 'refused', reason: `kill switch present (${KILL_SWITCH})` });
      return { ok: false, decision: 'refused', reason: [`kill switch present (${KILL_SWITCH})`] };
    }

    const taken = cycleTaken(cycle);
    if (taken) {
      audit({ ...base, decision: 'refused', reason: `cycle ${cycle} already used for ${taken.action} on ${taken.target} (one action per cycle)` });
      return { ok: false, decision: 'refused', reason: [`cycle ${cycle} already used for ${taken.action} on ${taken.target} (one action per cycle)`] };
    }

    let missing = [];
    try { missing = def.preconditions(spec, opts) || []; }
    catch (e) { missing = [`precondition check threw: ${e.message}`]; }
    if (missing.length) {
      audit({ ...base, decision: 'refused', reason: `preconditions not met: ${missing.join('; ')}`, preconditions: missing });
      return { ok: false, decision: 'refused', reason: missing };
    }

    let done = false;
    try { done = !!def.alreadyDone(spec, opts); }
    catch (e) { done = false; }
    if (done) {
      audit({ ...base, decision: 'noop', reason: 'idempotent: the effect already holds' });
      return { ok: true, decision: 'noop', reason: ['idempotent: the effect already holds'] };
    }

    const klass = (() => { try { return def.classify(spec, opts); } catch (e) { return 'unknown'; } })();

    // Building the command can fail — a missing run_id, an unknown action — and a throw here would
    // escape run() as a crash instead of an audited refusal. The executors are the last layer before the
    // world changes, so every path out of them must be a decision, never an exception.
    let argv, described;
    try {
      argv = def.argv(spec, opts);
      described = def.describe(spec, opts);
    } catch (e) {
      audit({ ...base, decision: 'refused', klass, reason: `cannot build the command: ${e.message}` });
      return { ok: false, decision: 'refused', reason: [e.message] };
    }

    if (!opts.apply) {
      audit({ ...base, decision: 'dry-run', klass, command: argv.join(' '), would_do: def.describe(spec, opts) });
      return { ok: true, decision: 'dry-run', command: argv.join(' '), would_do: def.describe(spec, opts) };
    }

    const r = guard.run(argv, { cwd: V2, dryRun: false, timeout: opts.timeout || 120000 });
    if (!r.ok) {
      audit({ ...base, decision: 'denied-or-failed', klass, command: argv.join(' '), error: r.error || (r.decision && r.decision.reason) || `exit ${r.exit}` });
      return { ok: false, decision: 'denied-or-failed', command: argv.join(' '), error: r.error };
    }
    markCycle(cycle, def.name, base.target);
    audit({ ...base, decision: 'applied', klass, command: argv.join(' '), output: String(r.stdout || '').slice(0, 400) });
    return { ok: true, decision: 'applied', command: argv.join(' '), output: r.stdout };
  }

  return { name: def.name, run };
}

module.exports = { makeExecutor, audit, killSwitchOn, KILL_SWITCH, CYCLE_FILE, AUDIT, V2, nowIso };
