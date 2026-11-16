// journal.test.js — the append-only contract for journal/lessons.jsonl and journal/decisions.jsonl.
//
// The rule was violated once: a simulation flipped a lesson's status with an in-place edit. These
// tests make the rule mechanical — a change must be an appended event, effective state must be
// computed, and an append must never touch a byte that already exists.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const V2 = 'D:/code/orca-supervisor';
const journal = require(path.join(V2, 'src/journal.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-test-'));
const seed = (name, lines) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
};

const L1 = { symptom: 'first symptom', root_cause: 'rc', evidence: 'ev', proposed_rule: 'pr', status: 'proposed' };
const L2 = { symptom: 'second symptom', root_cause: 'rc', evidence: 'ev', proposed_rule: 'pr', status: 'proposed' };

test('ids are derived deterministically, never stored', () => {
  const a = journal.lessonId(L1);
  const b = journal.lessonId({ ...L1 });
  assert.match(a, /^L[0-9a-f]{12}$/, 'lesson id shape');
  assert.strictEqual(a, b, 'same record -> same id, with no id field on the record');
  assert.notStrictEqual(a, journal.lessonId(L2), 'different records -> different ids');
  assert.ok(!('id' in L1), 'the id must not be written onto the record');
});

test('effective status falls back to the seed, then follows the newest event', () => {
  const p = seed('a.jsonl', [L1, L2]);
  let { lessons } = journal.lessonsWithStatus(p);
  assert.deepStrictEqual(lessons.map(l => l.status), ['proposed', 'proposed']);
  assert.strictEqual(lessons[0].from, 'seed');

  const id = journal.lessonId(L1);
  assert.ok(journal.appendEvent(p, { type: 'status_change', lesson_id: id, from: 'proposed', to: 'accepted', time: 't1', actor: 'test' }).ok);

  ({ lessons } = journal.lessonsWithStatus(p));
  assert.strictEqual(lessons[0].status, 'accepted', 'the event wins over the seed field');
  assert.strictEqual(lessons[0].from, 'event');
  assert.strictEqual(lessons[0].record.status, 'proposed', 'the record field is unchanged history');

  // Newest wins, and undoing is another event rather than a rewrite.
  assert.ok(journal.appendEvent(p, { type: 'status_change', lesson_id: id, from: 'accepted', to: 'rejected', time: 't2', actor: 'test' }).ok);
  ({ lessons } = journal.lessonsWithStatus(p));
  assert.strictEqual(lessons[0].status, 'rejected', 'the LAST event for an id decides');
});

test('a seed with no status field is read as the implicit default, never dropped or crashed on', () => {
  const noStatus = { symptom: 'a seed written before status was mandatory', root_cause: 'rc', evidence: 'ev', proposed_rule: 'pr' };
  const p = seed('c-statusless.jsonl', [noStatus, L1]);
  const { lessons } = journal.lessonsWithStatus(p);
  assert.strictEqual(lessons.length, 2, 'the status-less seed is still a lesson');
  const first = lessons.find(l => l.record.symptom === noStatus.symptom);
  assert.strictEqual(first.status, 'proposed', 'the implicit default is proposed');
  assert.strictEqual(first.from, 'seed');
  // The two readers that used to break on an undefined status: count-proposed filters on it, and the
  // list printer pads it. Both must survive a record that predates the field.
  assert.strictEqual(lessons.filter(l => l.status === 'proposed').length, 2);
  assert.ok(lessons.every(l => typeof l.status === 'string' && l.status.length > 0), 'no undefined status escapes');
});

test('appending never modifies an existing byte', () => {
  const p = seed('b.jsonl', [L1, L2]);
  const before = fs.readFileSync(p);
  journal.appendEvent(p, { type: 'status_change', lesson_id: journal.lessonId(L1), from: 'proposed', to: 'accepted', time: 't', actor: 'test' });
  const after = fs.readFileSync(p);
  assert.ok(after.length > before.length, 'the file grew');
  assert.strictEqual(Buffer.compare(before, after.subarray(0, before.length)), 0,
    'every pre-existing byte is identical — append-only, not rewrite');
});

test('a malformed or contradictory event is refused before it is written', () => {
  const p = seed('c.jsonl', [L1]);
  const len = fs.statSync(p).size;
  const cases = [
    [{ type: 'status_change', lesson_id: 'Lx', from: 'proposed', to: 'accepted', actor: 'test' }, 'missing time'],
    [{ type: 'status_change', lesson_id: 'Lx', from: 'proposed', to: 'nonsense', time: 't', actor: 'test' }, 'bad to'],
    [{ type: 'status_change', lesson_id: 'Lx', from: 'proposed', to: 'proposed', time: 't', actor: 'test' }, 'no-op event'],
    [{ type: 'supersede', decision_id: 'Dx', by: 'test', time: 't' }, 'missing reason'],
    [{ type: 'unknown', a: 1 }, 'unknown type'],
  ];
  for (const [ev, why] of cases) {
    const r = journal.appendEvent(p, ev);
    assert.strictEqual(r.ok, false, `must refuse: ${why}`);
    assert.ok(r.errors.length > 0, 'a refusal states why');
  }
  assert.strictEqual(fs.statSync(p).size, len, 'no refused event reached the file');
});

test('an append is refused when the file does not end in a newline', () => {
  const p = path.join(tmp, 'd.jsonl');
  fs.writeFileSync(p, JSON.stringify(L1));  // deliberately no trailing newline
  const r = journal.appendEvent(p, { type: 'status_change', lesson_id: journal.lessonId(L1), from: 'proposed', to: 'accepted', time: 't', actor: 'test' });
  assert.strictEqual(r.ok, false, 'appending would fuse two records into one broken line');
  assert.match(r.errors.join(' '), /newline/);
});

test('an event for an unknown record is ignored rather than crashing a reader', () => {
  const p = seed('e.jsonl', [L1]);
  journal.appendEvent(p, { type: 'status_change', lesson_id: 'L000000000000', from: 'proposed', to: 'accepted', time: 't', actor: 'test' });
  const { lessons, malformed } = journal.lessonsWithStatus(p);
  assert.strictEqual(lessons.length, 1, 'the known lesson is still readable');
  assert.strictEqual(lessons[0].status, 'proposed', 'a dangling event changes nothing');
  assert.strictEqual(malformed.length, 0, 'a dangling event is not a parse failure');
});

test('supersede marks a decision without touching it', () => {
  const d1 = { ts: 't0', kind: 'focus', source: 'user', content: 'the original decision', related: {} };
  const p = seed('f.jsonl', [d1]);
  let { decisions } = journal.decisionsWithStatus(p);
  assert.strictEqual(decisions[0].superseded, false);
  const r = journal.appendEvent(p, { type: 'supersede', decision_id: journal.decisionId(d1), actor: 'test', time: 't', reason: 'replaced by a later call' });
  assert.strictEqual(r.ok, true, `the event must be accepted: ${(r.errors || []).join('; ')}`);
  ({ decisions } = journal.decisionsWithStatus(p));
  assert.strictEqual(decisions[0].superseded, true);
  assert.strictEqual(decisions[0].reason, 'replaced by a later call');
  assert.strictEqual(decisions[0].record.content, 'the original decision', 'the original line is intact');
});

test('the live journals are readable and every line parses', () => {
  for (const file of [journal.LESSONS, journal.DECISIONS]) {
    const { malformed } = journal.readJsonl(file);
    assert.strictEqual(malformed.length, 0, `${file} has ${malformed.length} malformed line(s)`);
  }
});

test('no file writes a journal by literal path except the sanctioned writers', () => {
  // Mechanical, and deliberately narrow: it flags a WRITE whose argument names a journal file
  // directly. A file that merely mentions the journal path in prose (the proposal generator does)
  // is not an offender, and a writer that goes through a constant is covered by the behavioural
  // tests above — this one exists to catch a new, direct, unmediated writer.
  const allowed = new Set(['journal.js', 'checkpoint.js']);
  const offenders = [];
  for (const dir of ['src', 'bin']) {
    for (const f of fs.readdirSync(path.join(V2, dir))) {
      const p = path.join(V2, dir, f);
      if (!fs.statSync(p).isFile()) continue;
      const src = fs.readFileSync(p, 'utf8');
      const direct = /(writeFileSync|appendFileSync|createWriteStream)\s*\([^)]*journal[/\\](lessons|decisions)\.jsonl[^)]*\)/g.test(src);
      if (direct && !allowed.has(f)) offenders.push(`${dir}/${f}`);
    }
  }
  assert.deepStrictEqual(offenders, [], `direct journal writers that are not sanctioned: ${offenders.join(', ')}`);
});
