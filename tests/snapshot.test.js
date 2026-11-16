// snapshot.test.js — C1's contract, checked against a real recorded snapshot.
//
// The fixture is a live snapshot taken by src/snapshot.js on 2026-09-23 (masked at write time: command
// lines pass through the masker, and no credential is recorded). It is a fixture rather than a mock
// because the point of C1 is that the SHAPE survives contact with the real Orca/GitHub/host output —
// field names included. Three of the bugs found while building it were wrong field names, and a mock
// would have happily agreed with every one of them.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const V2 = 'D:/code/orca-supervisor';
const FIXTURE = path.join(V2, 'tests/fixtures/snapshot/live-2026-09-23.json');
const snap = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

test('the snapshot declares itself, and it is read-only by construction', () => {
  assert.strictEqual(snap.schema, 'snapshot/1');
  assert.strictEqual(snap.read_only, true);
  assert.match(snap.taken_at_utc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.strictEqual(snap.taken_by, 'src/snapshot.js');
  for (const section of ['orca', 'github', 'host', 'derived']) {
    assert.ok(snap[section] && typeof snap[section] === 'object', `section ${section} must exist`);
  }
});

test('a failed step is recorded, never silently dropped', () => {
  assert.ok(Array.isArray(snap.errors), 'errors must be an array');
  for (const e of snap.errors) {
    for (const f of ['step', 'command', 'error']) assert.ok(e[f] != null, `error entry missing ${f}`);
  }
});

test('the schema document exists and is the one the code follows', () => {
  const doc = path.join(V2, 'docs/snapshot-schema.md');
  assert.ok(fs.existsSync(doc), 'docs/snapshot-schema.md must exist');
  const text = fs.readFileSync(doc, 'utf8');
  for (const key of ['task_terminal_pr_table', 'orphan_dirs', 'verdict_comment', 'projection']) {
    assert.ok(text.includes(key), `schema doc must mention ${key}`);
  }
});

test('titles are read from task_title, not title', () => {
  const named = snap.orca.tasks.filter(t => t.title);
  assert.ok(named.length > 0, 'at least some tasks carry a title');
  // The regression: reading `title` off the record produced rows with empty titles that looked like
  // tasks without titles. A real title must be a real string.
  for (const t of named) assert.ok(String(t.title).trim().length > 3, `suspicious title: ${JSON.stringify(t.title)}`);
});

test('orphan_dirs is a set difference: nothing registered by Orca appears in it', () => {
  const registered = new Set(snap.orca.worktrees.map(w => String(w.path).replace(/\\/g, '/').toLowerCase()));
  assert.ok(snap.host.orphan_dirs.length > 0, 'this snapshot has orphans to check');
  for (const o of snap.host.orphan_dirs) {
    assert.strictEqual(o.registered, false, 'an orphan is by definition not registered');
    assert.ok(!registered.has(String(o.path).replace(/\\/g, '/').toLowerCase()), `registered tree in the orphan list: ${o.path}`);
    assert.ok(typeof o.size_bytes === 'number', 'size is recorded (0 when du could not measure)');
  }
  // derived must not invent: it lifts the same values.
  assert.deepStrictEqual(snap.derived.orphan_dirs, snap.host.orphan_dirs);
});

test('the table carries the fixer #93 worked example', () => {
  const rows = snap.derived.task_terminal_pr_table;
  assert.ok(rows.length > 0, 'the table is never empty while tasks are open');
  for (const r of rows) {
    for (const f of ['task_id', 'task_status', 'dispatched', 'pr']) assert.ok(f in r, `row missing ${f}`);
    if (r.dispatched) assert.ok(r.assignee_handle, 'a dispatched row names its assignee');
  }
  const fix = rows.find(r => /PR 93\b/.test(r.task_title || ''));
  assert.ok(fix, 'the fixer #93 task must be present as the worked example');
  assert.strictEqual(fix.pr.number, 93, 'its PR is linked by the number in the task title');
  assert.ok('mergeable' in fix.pr && 'verdict_comment' in fix.pr, 'the gate-relevant fields are carried');
});

test('an empty dispatch set is explained, not left to look like a healthy pipeline', () => {
  if (snap.orca.dispatches.length === 0) {
    assert.ok(snap.derived.notes.some(n => /no task is dispatched/.test(n)),
      'the table must say why it has no dispatched rows');
  }
});

test('the fixture is masked: no credential-shaped string survives', () => {
  const raw = fs.readFileSync(FIXTURE, 'utf8');
  // Mirrors the masker in src/snapshot.js, and deliberately tight for the same reason: the loose
  // form `sk[-_]…` matches the string `ta<sk_>terminal_pr_table`, so a test written that way fails on
  // a healthy fixture — which is exactly how the masker once rewrote a JSON key into `ta<masked>`.
  const leaks = [
    /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    /\bsk-[A-Za-z0-9]{20,}\b/g,
    /\bghp_[A-Za-z0-9]{20,}\b/g,
    /\bgho_[A-Za-z0-9]{20,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\beyJ[A-Za-z0-9._-]{20,}\b/g,
    /Bearer\s+[A-Za-z0-9._-]{10,}/g,
  ];
  for (const re of leaks) {
    const hit = raw.match(re);
    assert.strictEqual(hit, null, `fixture contains an unmasked secret: ${hit && hit[0]}`);
  }
  // And the masking must not have eaten the structure it protects.
  assert.ok(Array.isArray(snap.derived.task_terminal_pr_table), 'masking must not corrupt a key');
});

test('the host section is measured, not assumed', () => {
  assert.ok(snap.host.ram && typeof snap.host.ram.total_mb === 'number' && snap.host.ram.total_mb > 0);
  assert.ok(snap.host.disk, 'disk must be present');
  // C: is the binding constraint on this host, so its row is the one that must parse.
  assert.ok(snap.host.disk.c && snap.host.disk.c.mount, 'the C: row must parse (df wraps long names; asking for /c avoids it)');
  assert.ok(Array.isArray(snap.host.listeners));
  for (const l of snap.host.listeners) assert.ok(l.port >= 4173 && l.port <= 4221, 'only the reserved range is recorded');
});
