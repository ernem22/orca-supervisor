#!/usr/bin/env node
// src/journal.js — the append-only journal model for lessons.jsonl and decisions.jsonl.
//
// THE RULE (docs/state-model.md, class B): a journal record is never edited, never rewritten and
// never deleted. A state change is an APPENDED EVENT, not a modification of the record it describes.
// This was violated once — a simulation moved a lesson to `accepted` with an in-place edit — and the
// rule is now load-bearing rather than aspirational.
//
//   lessons:    {type:"status_change", lesson_id, from, to, time, actor}
//   decisions:  {type:"supersede",     decision_id, by, time, actor, reason}
//
// A record's EFFECTIVE status is the `to` of the most recent status_change for its id, falling back
// to the record's own `status` field (the seed value) when no event exists. Readers must ask this
// module rather than reading `status` off the record, because the record's field is a historical
// fact, not the current one.
//
// Identifiers are DERIVED, never stored: assigning an id would itself be an edit. A lesson's id is
// `L` + the first 12 hex of sha256(symptom); a decision's is `D` + the same over its content. Both
// are deterministic, so any reader re-derives the same id from the same bytes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const V2 = 'D:/code/orca-supervisor';
const LESSONS = path.join(V2, 'journal/lessons.jsonl');
const DECISIONS = path.join(V2, 'journal/decisions.jsonl');

const STATUSES = ['proposed', 'accepted', 'rejected'];
const LESSON_SEED_FIELDS = ['symptom', 'root_cause', 'evidence', 'proposed_rule', 'status'];
const STATUS_EVENT_FIELDS = ['type', 'lesson_id', 'from', 'to', 'time', 'actor'];
const SUPERSEDE_EVENT_FIELDS = ['type', 'decision_id', 'time', 'actor', 'reason'];

const short = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const lessonId = (rec) => 'L' + short(rec.symptom || '');
const decisionId = (rec) => 'D' + short(rec.content || '');

/** Read a JSONL file. A malformed line is REPORTED, never silently skipped. */
function readJsonl(file) {
  if (!fs.existsSync(file)) return { records: [], malformed: [] };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
  const records = [], malformed = [];
  lines.forEach((l, i) => {
    try { records.push({ ...JSON.parse(l), _line: i + 1 }); }
    catch (e) { malformed.push({ line: i + 1, error: e.message }); }
  });
  return { records, malformed };
}

/** Events only: the records that describe a change to another record. */
const eventsOf = (records) => records.filter(r => typeof r.type === 'string');

/** Effective status per lesson id, plus where it came from. */
function lessonStatusMap(file = LESSONS) {
  const { records, malformed } = readJsonl(file);
  const seeds = records.filter(r => !r.type && 'symptom' in r);
  const events = eventsOf(records).filter(e => e.type === 'status_change');
  const map = new Map();
  for (const s of seeds) {
    // A seed written before this field was mandatory carries no `status`. Read it as the implicit default
    // ("proposed") rather than letting `undefined` travel: an undefined status silently drops the record
    // from count-proposed's filter, and the list printer throws on `status.padEnd`. No record in the live
    // journal is missing the field today; the default exists so the next one cannot be invisible.
    map.set(lessonId(s), { id: lessonId(s), status: s.status || 'proposed', from: 'seed', line: s._line, record: s, history: [] });
  }
  // Newest wins. Events are appended in time order, so the last one for an id is the current one.
  for (const e of events) {
    const cur = map.get(e.lesson_id);
    if (!cur) continue; // an event for an unknown lesson is a dangling reference; reported by callers
    cur.status = e.to;
    cur.from = 'event';
    cur.line = e._line;
    cur.history.push(e);
  }
  return { map, malformed, seeds: seeds.length, events: events.length };
}

/** Lessons with their effective status, for readers such as the proposal generator and the gate. */
function lessonsWithStatus(file = LESSONS) {
  const { map, malformed, seeds, events } = lessonStatusMap(file);
  return { lessons: [...map.values()], malformed, seeds, events };
}

/** Decisions with their effective supersede state. */
function decisionsWithStatus(file = DECISIONS) {
  const { records, malformed } = readJsonl(file);
  const seeds = records.filter(r => !r.type && 'content' in r);
  const events = eventsOf(records).filter(e => e.type === 'supersede');
  const superseded = new Map();
  for (const e of events) superseded.set(e.decision_id, e);
  return {
    decisions: seeds.map(s => {
      const id = decisionId(s);
      const e = superseded.get(id);
      return { id, record: s, line: s._line, superseded: !!e, supersededBy: e ? e.actor : null, reason: e ? e.reason : null };
    }),
    malformed, seeds: seeds.length, events: events.length,
  };
}

function validate(event) {
  const errs = [];
  if (event.type === 'status_change') {
    for (const f of STATUS_EVENT_FIELDS) if (event[f] == null || String(event[f]).trim() === '') errs.push(`missing ${f}`);
    if (event.from && !STATUSES.includes(event.from)) errs.push(`from must be one of ${STATUSES.join('|')}`);
    if (event.to && !STATUSES.includes(event.to)) errs.push(`to must be one of ${STATUSES.join('|')}`);
    if (event.from && event.to && event.from === event.to) errs.push('from and to are the same; a no-op event is noise');
  } else if (event.type === 'supersede') {
    for (const f of SUPERSEDE_EVENT_FIELDS) if (event[f] == null || String(event[f]).trim() === '') errs.push(`missing ${f}`);
  } else {
    errs.push(`unknown event type ${JSON.stringify(event.type)}`);
  }
  return errs;
}

/** Append one event. Append-only: this never rewrites a line, and it refuses to fuse records. */
function appendEvent(file, event) {
  const errs = validate(event);
  if (errs.length) return { ok: false, errors: errs };
  if (!fs.existsSync(file)) return { ok: false, errors: [`no journal at ${file}`] };

  // A missing trailing newline would fuse this event onto the previous record and break the file.
  const raw = fs.readFileSync(file);
  if (raw.length && raw[raw.length - 1] !== 0x0a) {
    return { ok: false, errors: ['journal does not end with a newline; appending would corrupt the last record'] };
  }
  fs.appendFileSync(file, JSON.stringify(event) + '\n');

  // Re-parse the whole file: an append that breaks the journal must be reported, not assumed fine.
  const after = readJsonl(file);
  return { ok: true, malformed: after.malformed, records: after.records.length };
}

module.exports = {
  V2, LESSONS, DECISIONS, STATUSES, LESSON_SEED_FIELDS,
  readJsonl, lessonId, decisionId, lessonStatusMap, lessonsWithStatus, decisionsWithStatus,
  validate, appendEvent,
};

// A tiny CLI so non-JS callers — the Python cron scripts — use the SAME resolution rather than
// reimplementing it. Duplicated logic is how the two readers drifted apart in the first place.
if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'count-proposed') {
    const { lessons } = lessonsWithStatus();
    process.stdout.write(String(lessons.filter(l => l.status === 'proposed').length));
  } else if (cmd === 'list') {
    const { lessons, malformed } = lessonsWithStatus();
    for (const l of lessons) console.log(`${l.id}  ${l.status.padEnd(9)} (${l.from})  ${String(l.record.symptom).slice(0, 70)}`);
    console.log(`-- ${lessons.length} lesson(s), ${malformed.length} malformed line(s)`);
  } else if (cmd === 'status') {
    const { map } = lessonStatusMap();
    const hit = map.get(args[0]);
    console.log(hit ? `${hit.id} ${hit.status} (from ${hit.from}, line ${hit.line})` : `no lesson with id ${args[0]}`);
  } else if (cmd === 'append') {
    const event = JSON.parse(args.join(' '));
    const r = appendEvent(event.type === 'supersede' ? DECISIONS : LESSONS, event);
    console.log(r.ok ? `appended; ${r.records} record(s), ${r.malformed.length} malformed` : `REFUSED: ${r.errors.join('; ')}`);
    process.exit(r.ok ? 0 : 1);
  } else {
    console.log('usage: node src/journal.js count-proposed | list | status <id> | append <json>');
    process.exit(2);
  }
}
