// classify.test.js — C2's contract: the classes, the evidence kinds, and the two rules that matter
// most (no destructive evidence from absence; a finished-and-waiting worker is never frozen).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const V2 = 'D:/code/orca-supervisor';
const { classify, CLASSES, MIN_SAMPLE_MS } = require(path.join(V2, 'src/classify.js'));
const screensDoc = JSON.parse(fs.readFileSync(path.join(V2, 'tests/fixtures/screens/screens.json'), 'utf8'));
const S = screensDoc.screens;

/** A minimal snapshot shaped like src/snapshot.js output. */
function snap({ rows, dispatches = [], terminals = [], orphans = [] }) {
  return {
    schema: 'snapshot/1',
    taken_at_utc: '2026-09-23T12:00:00Z',
    orca: { terminals, dispatches },
    host: { orphan_dirs: orphans },
    derived: { task_terminal_pr_table: rows },
  };
}
const row = (id, status, handle, over = {}) => ({
  task_id: id, task_title: `task ${id}`, task_status: status, dispatched: !!handle,
  assignee_handle: handle, terminal: handle ? { handle, agent: 'opencode', state: 'active' } : null,
  liveness: null, requires_action: null, pr: null, ...over,
});
const disp = (id, handle, liveness) => ({ task_id: id, dispatch_id: `d_${id}`, assignee_handle: handle, liveness, attention: null, requires_action: false, next_action: null, resource_state: 'external' });

test('every class has at least one fixture that produces it', () => {
  const seen = new Set();
  // working
  seen.add(classify(snap({ rows: [row('t1', 'dispatched', 'h1')], dispatches: [disp('t1', 'h1', 'live')], terminals: [{ handle: 'h1', agent: 'opencode', state: 'active' }] }), { screens: { h1: S.term_working.text } }).rows[0].class);
  // provider-disconnect (the fixer #93 case)
  seen.add(classify(snap({ rows: [row('t2', 'dispatched', 'h2')], dispatches: [disp('t2', 'h2', 'live')], terminals: [{ handle: 'h2', agent: 'opencode', state: 'active' }] }), { screens: { h2: S.term_fixer93.text } }).rows[0].class);
  // idle-finished-unsettled
  seen.add(classify(snap({ rows: [row('t3', 'dispatched', 'h3')], dispatches: [disp('t3', 'h3', 'live')], terminals: [{ handle: 'h3', agent: 'opencode', state: 'active' }] }), { screens: { h3: S.term_tester114c.text } }).rows[0].class);
  // permission-wait
  seen.add(classify(snap({ rows: [row('t4', 'dispatched', 'h4')], dispatches: [disp('t4', 'h4', 'live')], terminals: [{ handle: 'h4', agent: 'opencode', state: 'active' }] }), { screens: { h4: S.term_fixer93_permission.text } }).rows[0].class);
  // rate-limited
  seen.add(classify(snap({ rows: [row('t5', 'dispatched', 'h5')], dispatches: [disp('t5', 'h5', 'live')], terminals: [{ handle: 'h5', agent: 'opencode', state: 'active' }] }), { screens: { h5: S.term_coder_rate.text } }).rows[0].class);
  // settled (task not dispatched)
  seen.add(classify(snap({ rows: [row('t6', 'ready', null)] })).rows[0].class);
  // zombie (dispatched, terminal gone)
  seen.add(classify(snap({ rows: [row('t7', 'dispatched', 'h7')], dispatches: [disp('t7', 'h7', 'live')], terminals: [] })).rows[0].class);
  // orphan-dir
  seen.add(classify(snap({ rows: [], orphans: [{ path: 'C:/x/orphan', size_bytes: 1024, registered: false }] })).rows[0].class);
  // working-frozen (suspect) — needs two samples >= 90 s apart with an identical counter
  const s = snap({ rows: [row('t8', 'dispatched', 'h8')], dispatches: [disp('t8', 'h8', 'live')], terminals: [{ handle: 'h8', agent: 'opencode', state: 'active' }] });
  const first = classify(s, { screens: { h8: S.term_frozen_t0.text }, now: '2026-09-23T12:00:00Z' });
  const second = classify(s, { screens: { h8: S.term_frozen_t1.text }, previous: first, now: '2026-09-23T12:05:00Z' });
  seen.add(second.rows[0].class);

  for (const c of CLASSES) assert.ok(seen.has(c), `no fixture produces the class ${c}`);
});

test('the fixer #93 screen classifies as provider-disconnect, with positive evidence', () => {
  const s = snap({ rows: [row('t', 'dispatched', 'h')], dispatches: [disp('t', 'h', 'live')], terminals: [{ handle: 'h', agent: 'opencode', state: 'active' }] });
  const r = classify(s, { screens: { h: S.term_fixer93.text } });
  assert.strictEqual(r.rows[0].class, 'provider-disconnect');
  assert.strictEqual(r.rows[0].evidence_kind, 'positive', 'the transcript itself is positive evidence');
  assert.match(r.rows[0].reason, /transport failure/);
});

test('REGRESSION: a finished-and-waiting worker is never classified as frozen', () => {
  // The 14:48 false positive: the turn had ended and the worker was waiting to be collected, and an
  // earlier detector called it frozen. Two samples, identical counter, far apart — and it must still
  // not be frozen, because the idle bar says the turn ended.
  const s = snap({ rows: [row('t', 'dispatched', 'h')], dispatches: [disp('t', 'h', 'live')], terminals: [{ handle: 'h', agent: 'opencode', state: 'active' }] });
  const first = classify(s, { screens: { h: S.term_finished_waiting.text }, now: '2026-09-23T12:00:00Z' });
  const second = classify(s, { screens: { h: S.term_finished_waiting.text }, previous: first, now: '2026-09-23T12:10:00Z' });
  assert.strictEqual(second.rows[0].class, 'idle-finished-unsettled');
  assert.strictEqual(second.rows[0].suspect_only, false);
  assert.strictEqual(second.inbox.length, 0, 'no stall-suspected item for a finished worker');
});

test('frozen is only a SUSPECT, and only with two samples far enough apart', () => {
  const s = snap({ rows: [row('t', 'dispatched', 'h')], dispatches: [disp('t', 'h', 'live')], terminals: [{ handle: 'h', agent: 'opencode', state: 'active' }] });

  // Samples 10 s apart: identical counter proves nothing.
  const a = classify(s, { screens: { h: S.term_frozen_t0.text }, now: '2026-09-23T12:00:00Z' });
  const tooClose = classify(s, { screens: { h: S.term_frozen_t1.text }, previous: a, now: '2026-09-23T12:00:10Z' });
  assert.notStrictEqual(tooClose.rows[0].class, 'working-frozen', 'loop counts are not evidence; timestamps are');
  assert.ok(tooClose.notes.some(n => /closer than 90 s/.test(n)), 'the refusal to call it frozen is stated');

  // Samples 5 minutes apart: suspect, and nothing more.
  const far = classify(s, { screens: { h: S.term_frozen_t1.text }, previous: a, now: '2026-09-23T12:05:00Z' });
  assert.strictEqual(far.rows[0].class, 'working-frozen');
  assert.strictEqual(far.rows[0].suspect_only, true);
  assert.strictEqual(far.rows[0].evidence_kind, 'absence', 'a frozen counter is absence of progress, not positive evidence');
  assert.strictEqual(far.inbox.length, 1);
  assert.strictEqual(far.inbox[0].type, 'stall-suspected');
  assert.ok(far.inbox[0].evidence_path, 'the inbox item carries an evidence path');
  assert.match(far.inbox[0].note, /escalate only/);
});

test('unverifiable liveness is absence, and grants no authority', () => {
  const s = snap({ rows: [row('t', 'dispatched', 'h')], dispatches: [disp('t', 'h', 'unverifiable')], terminals: [{ handle: 'h', agent: 'opencode', state: 'active' }] });
  const r = classify(s, { screens: {} });
  assert.strictEqual(r.rows[0].class, 'working');
  assert.strictEqual(r.rows[0].evidence_kind, 'absence');
  assert.match(r.rows[0].reason, /absence of evidence/);
  assert.strictEqual(r.rows[0].suspect_only, false);
});

test('exited liveness settles a task with positive evidence', () => {
  const s = snap({ rows: [row('t', 'dispatched', 'h')], dispatches: [disp('t', 'h', 'exited')], terminals: [{ handle: 'h', agent: 'opencode', state: 'active' }] });
  const r = classify(s, { screens: {} });
  assert.strictEqual(r.rows[0].class, 'settled');
  assert.strictEqual(r.rows[0].evidence_kind, 'positive');
});

test('a network drop is ONE event for >= 2 agents, not N coincidences', () => {
  const s = snap({
    rows: [row('t1', 'dispatched', 'h1'), row('t2', 'dispatched', 'h2')],
    dispatches: [disp('t1', 'h1', 'live'), disp('t2', 'h2', 'live')],
    terminals: [{ handle: 'h1', agent: 'opencode', state: 'active' }, { handle: 'h2', agent: 'opencode', state: 'active' }],
  });
  const r = classify(s, { screens: { h1: S.term_fixer93.text, h2: S.term_fixer93.text } });
  assert.ok(r.network_event, 'a shared event is recorded');
  assert.strictEqual(r.network_event.agents.length, 2);
  for (const x of r.rows) {
    assert.strictEqual(x.class, 'provider-disconnect');
    assert.strictEqual(x.network_event, r.network_event.event_id, 'both rows point at the same event');
  }
  assert.ok(r.notes.some(n => /not a rate limit/.test(n) && /retries are not burned/.test(n)));
});

test('a single agent with a transport error is provider-disconnect without a network event', () => {
  const s = snap({ rows: [row('t', 'dispatched', 'h')], dispatches: [disp('t', 'h', 'live')], terminals: [{ handle: 'h', agent: 'opencode', state: 'active' }] });
  const r = classify(s, { screens: { h: S.term_fixer93.text } });
  assert.strictEqual(r.network_event, null);
  assert.strictEqual(r.rows[0].class, 'provider-disconnect');
});

test('the fixture set is honest about what was recorded and what was rebuilt', () => {
  for (const [name, v] of Object.entries(S)) {
    assert.ok(['recorded', 'reconstructed'].includes(v.source), `${name} must declare its source`);
    assert.ok(v.incident && v.incident.length > 20, `${name} must name the incident it comes from`);
    assert.ok(v.text && v.text.length > 10, `${name} must carry screen text`);
  }
  // The fixer #93 terminal no longer exists, so that screen can only be a reconstruction.
  assert.strictEqual(S.term_fixer93.source, 'reconstructed');
});
