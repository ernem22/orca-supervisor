#!/usr/bin/env node
// tests/capacity.test.js — D1's rule, tested as a rule rather than as a number.
//
// Free RAM on this host swings roughly 1.5 GB with no load change, so nothing here asserts a particular
// free_slots value. What must hold is the arithmetic, the floor at zero, and the fact that every call
// re-reads the machine instead of remembering it.
const test = require('node:test');
const assert = require('node:assert');
// Before anything requires _core.js: keep this file's executor runs out of the real audit trail, which
// tests/actions.test.js asserts on from a parallel process.
process.env.SUP_V2_STATE_DIR = require('node:path').join(require('node:os').tmpdir(), `sup-v2-test-${process.pid}`);
const capacity = require('../src/capacity.js');

test('free_slots is computed from the live reading, floored at zero', () => {
  const c = capacity.freeSlots();
  assert.equal(typeof c.available_mb, 'number');
  assert.ok(c.available_mb > 0, 'zero available MB is not a state this can observe');
  const usable = c.available_mb - capacity.MARGIN_MB;
  const expected = usable <= 0 ? 0 : Math.floor(usable / capacity.PEAK_MB_PER_WORKER);
  assert.equal(c.free_slots, expected);
  assert.ok(c.free_slots >= 0, 'never negative');
});

test('a reading carries its own basis and timestamp — it is a measurement, not a state', () => {
  const c = capacity.freeSlots();
  assert.match(c.basis, /floored at 0/);
  assert.ok(Date.parse(c.taken_at_utc) > 0);
  assert.match(c.source, /never cached/);
});

test('the margin is the D1 stop-adding-load floor, and the peak is the measured peak', () => {
  assert.equal(capacity.MARGIN_MB, 700);
  assert.equal(capacity.PEAK_MB_PER_WORKER, 400);
});

test('a spec without free_slots is measured live, and a zero reading refuses the spawn', () => {
  const spawn = require('../src/actions/spawn.js');
  const spec = { worktree: 'name:sup-sandbox-wt6', issue_number: 126, issue_label_agent: true };
  const r = spawn.run(spec, { cycle: 'capacity-test-live' });
  // `reason` is always an array now, and the expectation must not come from a SECOND live reading: free
  // RAM on this host moves by hundreds of MB in seconds, so a re-read can disagree with the reading the
  // decision actually used. The spec carries that reading, so the assertion is taken from it.
  const reasons = Array.isArray(r.reason) ? r.reason : [r.reason].filter(Boolean);
  const refusedForCapacity = reasons.filter(m => /no free slot|could not be read live/.test(m));
  const reading = spec.free_slots;
  assert.equal(typeof reading, 'number', 'the decision records the reading it was based on');
  if (reading < 1) assert.equal(refusedForCapacity.length, 1, 'a zero reading must refuse');
  else assert.equal(refusedForCapacity.length, 0, 'a real slot must not be refused for capacity');
  assert.ok(spec.capacity && spec.capacity.available_mb > 0);
});

test('an explicit free_slots is honoured and never overwritten by the live read', () => {
  const spawn = require('../src/actions/spawn.js');
  const r = spawn.run({ worktree: 'name:sup-sandbox-wt6', free_slots: 0, issue_number: 126, issue_label_agent: true }, { cycle: 'capacity-test-explicit' });
  assert.equal((r.reason || []).filter(m => /^no free slot/.test(m)).length, 1);
});
