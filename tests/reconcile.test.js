// reconcile.test.js — C3's contract, and the end-to-end gut-check for the fixer #93 incident.
//
// The last test in this file is the one that matters: it runs the real snapshot -> classify ->
// reconcile chain over a reconstruction of 2026-09-21 13:18Z and asserts what the design WOULD have
// proposed that day. Components passing their own tests proves they work; this proves they add up.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const V2 = 'D:/code/orca-supervisor';
const { classify } = require(path.join(V2, 'src/classify.js'));
const { reconcile, DESTRUCTIVE } = require(path.join(V2, 'src/reconcile.js'));

const INCIDENT = JSON.parse(fs.readFileSync(path.join(V2, 'tests/fixtures/snapshot/fixer93-incident.json'), 'utf8'));

function snap({ rows, dispatches = [], terminals = [], issues = [], orphans = [] }) {
  return {
    schema: 'snapshot/1', taken_at_utc: '2026-09-23T12:00:00Z',
    orca: { terminals, dispatches }, github: { issues, prs: [] },
    host: { orphan_dirs: orphans }, derived: { task_terminal_pr_table: rows },
  };
}
const row = (id, status, handle, over = {}) => ({
  task_id: id, task_title: `task ${id}`, task_status: status, dispatched: !!handle,
  assignee_handle: handle, terminal: handle ? { handle, agent: 'opencode', state: 'active' } : null,
  liveness: null, pr: null, ...over,
});
const disp = (id, handle, liveness) => ({ task_id: id, assignee_handle: handle, liveness });
const cls = (rows) => ({ observed_at: '2026-09-23T12:00:00Z', rows });

test('absence evidence may only escalate — never a destructive action', () => {
  const c = cls([{ task_id: 't', class: 'working', evidence_kind: 'absence', reason: 'liveness unverifiable', task_status: 'dispatched' }]);
  const r = reconcile(snap({ rows: [row('t', 'dispatched', 'h', { pr: { number: 1, mergeable: 'MERGEABLE', verdict_comment: true } })] }), c);
  assert.ok(r.rows.length > 0);
  for (const x of r.rows) {
    assert.strictEqual(x.action, 'escalate', 'an absence row cannot do anything but escalate');
    assert.ok(!DESTRUCTIVE.has(x.action));
  }
});

test('a destructive action is withheld when the work is not pushed', () => {
  // provider-disconnect WITH positive evidence, but no PR: fencing could lose local-only work.
  const c = cls([{ task_id: 't', class: 'provider-disconnect', evidence_kind: 'positive', reason: 'transport failure', task_status: 'dispatched' }]);
  const r = reconcile(snap({ rows: [row('t', 'dispatched', 'h', { pr: null })] }), c);
  const abandon = r.rows.find(x => x.action === 'abandon');
  assert.strictEqual(abandon, undefined, 'no abandon without a pushed branch');
  const esc = r.rows.find(x => x.action === 'escalate');
  assert.match(esc.reason, /NOT pushed/);
  assert.strictEqual(esc.safe, false);
});

test('a destructive action is proposed when the work is pushed and the state is known', () => {
  const c = cls([{ task_id: 't', class: 'provider-disconnect', evidence_kind: 'positive', reason: 'transport failure', task_status: 'dispatched' }]);
  const r = reconcile(snap({ rows: [row('t', 'dispatched', 'h', { pr: { number: 93, mergeable: 'MERGEABLE', verdict_comment: false } })] }), c);
  const nudge = r.rows.find(x => x.action === 'nudge');
  const abandon = r.rows.find(x => x.action === 'abandon');
  assert.ok(nudge && abandon, 'the design nudges first, then fences');
  assert.strictEqual(abandon.safe, true);
  assert.ok(abandon.preconditions.some(p => /pushed/.test(p)));
});

test('working-frozen escalates and never abandons, at any duration', () => {
  const c = cls([{ task_id: 't', class: 'working-frozen', evidence_kind: 'absence', reason: 'counter unchanged across two samples 300 s apart', task_status: 'dispatched' }]);
  const r = reconcile(snap({ rows: [row('t', 'dispatched', 'h', { pr: { number: 1, mergeable: 'MERGEABLE', verdict_comment: true } })] }), c);
  assert.deepStrictEqual([...new Set(r.rows.map(x => x.action))], ['escalate']);
  assert.ok(r.rows.some(x => /suspect, never proof/.test(x.reason)));
});

test('settled + mergeable PR + no verdict is a gate-ready notice, not a merge', () => {
  const c = cls([{ task_id: 't', class: 'settled', evidence_kind: 'positive', reason: 'task is ready and not dispatched', task_status: 'ready', terminal_state: null }]);
  const r = reconcile(snap({ rows: [row('t', 'ready', null, { pr: { number: 93, mergeable: 'MERGEABLE', verdict_comment: false, checks_state: 'success' } })] }), c);
  const g = r.rows.find(x => x.action === 'gate-ready');
  assert.ok(g, 'the gate notice is proposed');
  assert.match(g.reason, /waiting at the gate/);
  assert.ok(g.preconditions.some(p => /verdict/.test(p)));
  assert.ok(!r.rows.some(x => /merge\b/.test(x.action)), 'no merge action exists');
});

test('spawn is proposed only with a free slot AND an eligible issue', () => {
  const base = snap({ rows: [], issues: [{ number: 121, labels: ['agent'] }] });
  const unknown = reconcile(base, cls([]), {});
  assert.strictEqual(unknown.rows[0].action, 'escalate');
  assert.match(unknown.rows[0].reason, /capacity is unknown/);

  const full = reconcile(base, cls([]), { capacity: { free_slots: 0 } });
  assert.strictEqual(full.rows[0].action, 'escalate');
  assert.match(full.rows[0].reason, /queue is state/);

  const free = reconcile(base, cls([]), { capacity: { free_slots: 2 } });
  assert.strictEqual(free.rows[0].action, 'spawn');
  assert.match(free.rows[0].target, /issue#121/);

  const noIssue = reconcile(snap({ rows: [], issues: [{ number: 5, labels: ['human-merge'] }] }), cls([]), { capacity: { free_slots: 2 } });
  assert.match(noIssue.rows[0].reason, /no eligible issue/);
});

test('reconcile.js starts no process — it proposes, and that is all it can do', () => {
  const src = fs.readFileSync(path.join(V2, 'src/reconcile.js'), 'utf8');
  for (const forbidden of ['child_process', 'guard/exec', 'execSync', 'spawn(']) {
    assert.ok(!src.includes(forbidden), `reconcile.js must not contain ${forbidden}`);
  }
  assert.match(src, /executes: 'nothing'/);
});

// ---------------------------------------------------------------------------------------------
// THE GUT-CHECK: 2026-09-21 13:18Z, end to end through the real chain.
// ---------------------------------------------------------------------------------------------
test('INCIDENT 2026-09-21 13:18Z: snapshot -> classify -> reconcile, what would it have proposed?', () => {
  const classification = classify(INCIDENT, { screens: INCIDENT.screens });
  const r = reconcile(INCIDENT, classification, { capacity: { free_slots: 0 } });

  const byTask = (id) => r.rows.filter(x => x.target === id);
  const fixer = byTask('task_c23d87eea0c9');

  // 1. The stuck fixer is identified, and identified correctly.
  const fixerClass = classification.rows.find(x => x.task_id === 'task_c23d87eea0c9');
  assert.strictEqual(fixerClass.class, 'provider-disconnect');
  assert.strictEqual(fixerClass.evidence_kind, 'positive');

  // 2. The design proposes nudge -> abandon, and both are safe because PR 93 exists.
  const nudge = fixer.find(x => x.action === 'nudge');
  const abandon = fixer.find(x => x.action === 'abandon');
  assert.ok(nudge, 'a nudge is proposed first');
  assert.ok(abandon, 'a fence is proposed');
  assert.strictEqual(abandon.safe, true, 'safe: the branch is on GitHub as PR 93');

  // 3. The tester, which was idle with no report, is nudged rather than fenced blind.
  const tester = classification.rows.find(x => x.task_id === 'task_0e29a5e03a38');
  assert.strictEqual(tester.class, 'idle-finished-unsettled');

  // 4. The capacity answer is consumed, not guessed: 0 free slots means no spawn, and it says so.
  const spawnRow = r.rows.find(x => x.target === 'spawn');
  assert.strictEqual(spawnRow.action, 'escalate');
  assert.match(spawnRow.reason, /capacity: 0 free slot/);

  // 5. Nothing in the output is an execution, and no row is an unsafe destructive action.
  assert.strictEqual(r.executes, 'nothing');
  assert.ok(!r.rows.some(x => DESTRUCTIVE.has(x.action) && !x.safe), 'no unsafe destructive row');
});
