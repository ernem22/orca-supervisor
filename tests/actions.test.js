// actions.test.js — E1's contract: the four executors refuse more than they do, and the last line of
// defence is not the executors at all but the guard.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const V2 = 'D:/code/orca-supervisor';
// Own state directory BEFORE anything requires _core.js: the kill switch and the cycle token now follow
// SUP_V2_STATE_DIR, so this file's executor runs cannot collide with a sibling test process — which is
// exactly how the capacity test once saw a refusal string where it expected a list.
process.env.SUP_V2_STATE_DIR = path.join(require('node:os').tmpdir(), `sup-v2-test-actions-${process.pid}`);
const guard = require(path.join(V2, 'src/guard/exec.js'));
const core = require(path.join(V2, 'src/actions/_core.js'));
const nudge = require(path.join(V2, 'src/actions/nudge.js'));
const abandon = require(path.join(V2, 'src/actions/abandon.js'));
const reap = require(path.join(V2, 'src/actions/reap.js'));
const spawn = require(path.join(V2, 'src/actions/spawn.js'));

const auditLines = () => {
  try { return fs.readFileSync(core.AUDIT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch (e) { return []; }
};
const lastAudit = () => auditLines().slice(-1)[0];

const PUSHED = { dispatch_id: 'd1', task_id: 't1', assignee_handle: 'h1', evidence_kind: 'positive', pr_number: 93, resource_state: 'supervised', liveness: 'live',
  // Required since the nudge stopped falling back to a run id: a missing run_id is now an audited
  // refusal, not a command aimed at the live run.
  run_id: 'run_sandbox_test', coordinator_handle: 'term_sandbox_test' };

test('the kill switch refuses every executor, whatever the flags', () => {
  fs.mkdirSync(path.dirname(core.KILL_SWITCH), { recursive: true });
  fs.writeFileSync(core.KILL_SWITCH, 'disabled for the test\n');
  try {
    for (const ex of [nudge, abandon, reap, spawn]) {
      const r = ex.run(PUSHED, { apply: true, cycle: `kill-${ex.name}` });
      assert.strictEqual(r.decision, 'refused');
      assert.match(r.reason.join(' | '), /kill switch/);
    }
  } finally {
    fs.unlinkSync(core.KILL_SWITCH);
  }
});

test('dry run is the default: nothing is applied without --apply', () => {
  const r = nudge.run(PUSHED, { cycle: 'dry-1' });
  assert.strictEqual(r.decision, 'dry-run');
  assert.ok(r.command.startsWith('orca orchestration send'));
  assert.match(r.would_do, /ask dispatch d1/);
  assert.strictEqual(lastAudit().decision, 'dry-run');
});

test('one action per cycle, enforced on disk', () => {
  const spec = { ...PUSHED, cycle: 'cycle-x' };
  // Mark the cycle by applying a dry run is not enough — the token is written only on a real apply, so
  // the guard is exercised through the core's own bookkeeping.
  core.audit({ action: 'test', decision: 'marker' });
  fs.writeFileSync(core.CYCLE_FILE, JSON.stringify({ cycle: 'cycle-x', action: 'reap', target: 't1', at: new Date().toISOString() }));
  try {
    const r = nudge.run(spec, { cycle: 'cycle-x' });
    assert.strictEqual(r.decision, 'refused');
    assert.match(r.reason.join(' | '), /one action per cycle/);
  } finally {
    fs.unlinkSync(core.CYCLE_FILE);
  }
});

test('abandon requires positive evidence AND a pushed branch', () => {
  const noEvidence = abandon.run({ ...PUSHED, evidence_kind: 'absence' }, { cycle: 'a1' });
  assert.strictEqual(noEvidence.decision, 'refused');
  assert.ok(noEvidence.reason.some(x => /absence grants no authority/.test(x)), JSON.stringify(noEvidence.reason));

  const notPushed = abandon.run({ ...PUSHED, pr_number: null }, { cycle: 'a2' });
  assert.strictEqual(notPushed.decision, 'refused');
  assert.ok(notPushed.reason.some(x => /not pushed/.test(x)), JSON.stringify(notPushed.reason));

  const ok = abandon.run(PUSHED, { cycle: 'a3' });
  assert.strictEqual(ok.decision, 'dry-run');
  assert.strictEqual(ok.command, 'orca orchestration worker-abandon --dispatch d1');
});

test('abandon refuses an external terminal rather than improvising a kill', () => {
  const r = abandon.run({ ...PUSHED, resource_state: 'external', klass: 'external' }, { cycle: 'a4' });
  assert.strictEqual(r.decision, 'refused');
  assert.ok(r.reason.some(x => /no fence for an operator-created process/.test(x)));
});

test('reap refuses an unsettled task and the coordinator worktree', () => {
  const unsettled = reap.run({ task_id: 't1', terminal_handle: 'h1', task_terminal: false, task_status: 'dispatched' }, { cycle: 'r1' });
  assert.strictEqual(unsettled.decision, 'refused');
  const coord = reap.run({ task_id: 't1', terminal_handle: 'h1', task_terminal: true, worktree_is_coordinator: true }, { cycle: 'r2' });
  assert.strictEqual(coord.decision, 'refused');
  assert.ok(coord.reason.some(x => /coordinator worktree/.test(x)));
});

test('reap picks the class-appropriate command', () => {
  const sup = reap.run({ task_id: 't1', terminal_handle: 'h1', task_terminal: true, resource_state: 'supervised', dispatch_id: 'd1' }, { cycle: 'r3' });
  assert.strictEqual(sup.command, 'orca orchestration worker-release --dispatch d1');
  const ext = reap.run({ task_id: 't1', terminal_handle: 'h1', task_terminal: true, resource_state: 'external', dispatch_id: 'd1' }, { cycle: 'r4' });
  assert.strictEqual(ext.command, 'orca terminal close --terminal h1');
  assert.match(ext.would_do, /accounting will not converge/);
});

test('SCENARIO 9: spawn refuses `--worktree current`', () => {
  const r = spawn.run({ worktree: 'current', free_slots: 3, issue_number: 121, issue_label_agent: true }, { cycle: 's1' });
  assert.strictEqual(r.decision, 'refused');
  assert.ok(r.reason.some(x => /SCENARIO 9/.test(x)), JSON.stringify(r.reason));
});

test('spawn measures capacity live instead of assuming an answer', () => {
  const cap = require('../src/capacity.js').freeSlots();
  const r = spawn.run({ worktree: 'C:/x/wt', issue_number: 121, issue_label_agent: true }, { cycle: 's2' });
  // D1's rule: the reading is taken now, from this machine, with whatever is already running on it.
  // A machine with a real free slot must not be refused for capacity; a full one must be.
  if (cap.free_slots < 1) {
    assert.strictEqual(r.decision, 'refused');
    assert.ok(r.reason.some(x => /no free slot/.test(x)));
  } else {
    assert.notStrictEqual(r.decision, 'refused', 'a real free slot must not be refused for capacity');
  }

  const full = spawn.run({ worktree: 'C:/x/wt', free_slots: 0, issue_number: 121, issue_label_agent: true }, { cycle: 's3' });
  assert.strictEqual(full.decision, 'refused');
  assert.ok(full.reason.some(x => /no free slot/.test(x)));
});

test('spawn refuses a second sandbox worker while live workers run', () => {
  const r = spawn.run({ worktree: 'C:/x/wt', free_slots: 3, issue_number: 121, issue_label_agent: true, live_workers: 2, sandbox_workers: 1 }, { cycle: 's4' });
  assert.strictEqual(r.decision, 'refused');
  assert.ok(r.reason.some(x => /sandbox limit/.test(x)));
});

test('spawn proposes the managed path when everything holds', () => {
  const r = spawn.run({ worktree: 'C:/x/wt', free_slots: 3, issue_number: 121, issue_label_agent: true, live_workers: 0, sandbox_workers: 0 }, { cycle: 's5' });
  assert.strictEqual(r.decision, 'dry-run');
  assert.match(r.command, /^orca orchestration worker-start --worktree C:\/x\/wt --agent opencode$/);
});

test('idempotence: an effect that already holds is a no-op, not a second action', () => {
  const r = nudge.run({ ...PUSHED, liveness: 'exited' }, { cycle: 'i1' });
  assert.strictEqual(r.decision, 'noop');
  assert.strictEqual(lastAudit().decision, 'noop');
});

test('every decision lands in the audit log', () => {
  const before = auditLines().length;
  abandon.run({ ...PUSHED, evidence_kind: 'absence' }, { cycle: 'audit-1' });
  nudge.run(PUSHED, { cycle: 'audit-2' });
  const after = auditLines();
  assert.ok(after.length >= before + 2, 'refusals and dry runs are both audited');
  for (const l of after.slice(-2)) assert.ok(l.ts && l.action && l.decision, JSON.stringify(l));
});

test('the executors never call the old pipeline scripts', () => {
  for (const f of ['_core.js', 'nudge.js', 'abandon.js', 'reap.js', 'spawn.js']) {
    // Strip comments before scanning: these files NAME the old scripts on purpose ("the existing
    // reap.sh is NOT called"), and a scan that cannot tell a mention from an invocation flags the
    // documentation instead of the code.
    const src = fs.readFileSync(path.join(V2, 'src/actions', f), 'utf8')
      .split('\n').map(l => l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')).join('\n');
    for (const forbidden of ['spawn.sh', 'reap.sh', 'sweep.sh', 'close.sh']) {
      assert.ok(!src.includes(forbidden), `${f} must not invoke ${forbidden}`);
    }
    assert.ok(!/child_process/.test(src), `${f} must go through the guard, not child_process`);
  }
});

test('the last line of defence is the guard: the write verbs are denied today', () => {
  // This is what "default OFF on the live system" means mechanically. The executors are built; the
  // gate refuses to let them act. Cutover (E3) is the decision that changes this, not a flag.
  const denied = [
    ['orca', 'orchestration', 'worker-start', '--worktree', 'C:/x/wt', '--agent', 'opencode'],
    ['orca', 'orchestration', 'worker-abandon', '--dispatch', 'd1'],
    ['orca', 'orchestration', 'worker-release', '--dispatch', 'd1'],
    ['orca', 'terminal', 'close', '--terminal', 'h1'],
  ];
  for (const argv of denied) {
    const d = guard.decide(argv, {});
    assert.strictEqual(d.allow, false, `${argv.join(' ')} must be denied by the guard`);
  }
});
