#!/usr/bin/env node
// checkpoint.test.js — B1: schema, size caps, atomicity, append-only, and the class-A leak guard.
//
// The module reads its paths from SUP_STATE_DIR, set here to a scratch dir, so these tests never
// touch the real journal or handoff.
//
//   node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-b1-'));
process.env.SUP_STATE_DIR = SCRATCH;

const cp = require('../src/checkpoint.js');

const good = () => ({
  ts: '2026-09-21T15:41:17Z',
  kind: 'deviation',
  content: 'Did not run the +30min stability capture in the same turn because verify-untouched was mid-edit; re-ran it later instead.',
  source: 'self',
  related: { pr: 93 },
});

test('validateDecision accepts a well-formed decision', () => {
  assert.deepStrictEqual(cp.validateDecision(good()), []);
  for (const kind of cp.KINDS) {
    assert.deepStrictEqual(cp.validateDecision({ ...good(), kind }), [], `kind ${kind} should be accepted`);
  }
  for (const source of cp.SOURCES) {
    assert.deepStrictEqual(cp.validateDecision({ ...good(), source }), [], `source ${source} should be accepted`);
  }
});

test('validateDecision rejects malformed decisions, naming each problem', () => {
  const cases = [
    [{ ...good(), ts: 'yesterday' }, /ISO-8601/],
    [{ ...good(), kind: 'status' }, /kind must be one of/],
    [{ ...good(), source: 'robot' }, /source must be one of/],
    [{ ...good(), content: '   ' }, /must not be empty/],
    [{ ...good(), content: 'x'.repeat(cp.DECISION_MAX_BYTES + 1) }, /exceeds/],
    [{ ...good(), related: { pr: 1, nope: 2 } }, /not a known key/],
    [{ ...good(), related: ['pr'] }, /related must be an object/],
    [{ ts: '2026-09-21T15:41:17Z', kind: 'focus', source: 'user' }, /missing field: content/],
    [null, /JSON object/],
  ];
  for (const [bad, re] of cases) {
    const errs = cp.validateDecision(bad);
    assert.ok(errs.length > 0, `expected rejection for ${JSON.stringify(bad).slice(0, 60)}`);
    assert.ok(errs.some(e => re.test(e)), `expected an error matching ${re}; got ${JSON.stringify(errs)}`);
  }
});

test('the class-A leak guard rejects pipeline state dressed as a decision', () => {
  const leaks = [
    'dispatch is running for task_c23d87eea0c9',
    'task status: dispatched',
    'headRefOid = 57d7a7c6e58bfba503bc256658b89ae41192d72f',
    'mergeable: CONFLICTING',
    'running tasks: 3',
  ];
  for (const content of leaks) {
    const errs = cp.validateDecision({ ...good(), content });
    assert.ok(errs.some(e => /class-A/.test(e)), `expected a class-A rejection for: ${content}`);
  }
  // and it must NOT reject a real decision that merely mentions a PR or a task id
  const real = { ...good(), content: 'Held tester-114c back until tester-113 settled, to keep two browser-driving workers off the machine at once.', related: { task: 'task_c23d87eea0c9' } };
  assert.deepStrictEqual(cp.validateDecision(real), []);
});

test('appendDecision is append-only, ordered, and never writes a rejected line', () => {
  const before = fs.existsSync(cp.JOURNAL) ? fs.readFileSync(cp.JOURNAL, 'utf8') : '';
  const bad = cp.appendDecision({ ...good(), kind: 'nonsense' });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(fs.existsSync(cp.JOURNAL) ? fs.readFileSync(cp.JOURNAL, 'utf8') : '', before,
    'a rejected decision must not create or modify the journal');

  const a = cp.appendDecision({ ...good(), ts: '2026-09-21T15:00:00Z', content: 'First decision.' });
  const b = cp.appendDecision({ ...good(), ts: '2026-09-21T16:00:00Z', content: 'Second decision.' });
  assert.strictEqual(a.ok, true);
  assert.strictEqual(b.ok, true);

  const { lines } = cp.readDecisions(10);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].content, 'First decision.');
  assert.strictEqual(lines[1].content, 'Second decision.');
});

test('readDecisions reports a malformed line instead of dropping it', () => {
  fs.appendFileSync(cp.JOURNAL, '{ this is not json\n');
  const d = cp.readDecisions(10);
  assert.strictEqual(d.malformed.length, 1);
  assert.strictEqual(d.lines.length, 2, 'the good lines are still returned');
});

test('writeHandoff enforces the byte cap', () => {
  const big = '## Now\n' + 'x'.repeat(cp.HANDOFF_MAX_BYTES) + '\n## Next\nn\n## Waiting on\nw\n## Risks\nr\n';
  const r = cp.writeHandoff(big);
  assert.strictEqual(r.ok, false);
  assert.match(r.errors[0], /cap is 2048/);
  assert.strictEqual(cp.readHandoff(), null, 'nothing was written');
});

test('writeHandoff requires the four headings', () => {
  const r = cp.writeHandoff('## Now\nsomething\n## Next\nsomething\n');
  assert.strictEqual(r.ok, false);
  assert.match(r.errors[0], /missing heading/);
});

test('writeHandoff is atomic: no temp file survives, and the previous content is intact on failure', () => {
  const ok = cp.writeHandoff('## Now\nStanding up the v2 supervisor.\n## Next\nB2 — lossless compression design.\n## Waiting on\nNothing.\n## Risks\nContext compaction losing the runbook.\n');
  assert.strictEqual(ok.ok, true);
  const first = cp.readHandoff();
  assert.match(first, /## Now/);

  const leftovers = fs.readdirSync(SCRATCH).filter(f => f.includes('.tmp-'));
  assert.deepStrictEqual(leftovers, [], 'no temp file may survive a successful write');

  const failed = cp.writeHandoff('## Now\n' + 'y'.repeat(4096) + '\n## Next\nn\n## Waiting on\nw\n## Risks\nr\n');
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(cp.readHandoff(), first, 'a rejected write must leave the old handoff byte-identical');
});

test('the fixer #93 case: a real decision and handoff pass the schema', () => {
  const decisions = [
    { ts: '2026-09-21T15:34:33Z', kind: 'focus', source: 'user', content: 'Build the supervisor as a new layer beside the pipeline; never modify the pipeline, its skills or its cron jobs.', related: {} },
    { ts: '2026-09-21T15:41:17Z', kind: 'question', source: 'self', content: 'Asked the user whether to authorise copying the main profile credential into orca-sup; refused to copy a secret unasked.', related: {} },
    { ts: '2026-09-22T13:24:32Z', kind: 'deviation', source: 'self', content: 'Concluded pin alone does not block an agent-side skill patch, after a pinned throwaway skill was patched successfully; B3 must also use skills.write_approval.', related: {} },
  ];
  for (const d of decisions) assert.deepStrictEqual(cp.validateDecision(d), [], JSON.stringify(d));
});
