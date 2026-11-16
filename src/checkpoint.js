#!/usr/bin/env node
// src/checkpoint.js — the only writer of journal/decisions.jsonl and handoff.md (B1).
//
// Three jobs, all of them about keeping the supervisor honest after a compaction:
//   1. validate a decision against the schema in docs/state-model.md,
//   2. refuse content that belongs to another class (pipeline state creeping into the journal,
//      or a handoff that grew into a status report),
//   3. write atomically — temp file + rename — so a crash leaves the previous file intact
//      rather than a half-written one.
//
// Nothing here touches Hermes. It is filesystem-only and has no dependencies.

const fs = require('fs');
const path = require('path');

const V2 = 'D:/code/orca-supervisor';
// Tests redirect these two paths with SUP_STATE_DIR so they never touch the real journal/handoff.
const STATE_DIR = process.env.SUP_STATE_DIR || V2;
const JOURNAL = path.join(STATE_DIR, 'journal/decisions.jsonl');
const HANDOFF = path.join(STATE_DIR, 'handoff.md');

const HANDOFF_MAX_BYTES = 2048;
const DECISION_MAX_BYTES = 1024;
const KINDS = ['focus', 'preference', 'question', 'deviation', 'approval'];
const SOURCES = ['user', 'self'];

// Class-A leakage: a decision line that describes where the pipeline IS, not what someone CHOSE.
// Kept deliberately narrow — it must not reject a real decision that happens to mention a PR.
const CLASS_A_PATTERNS = [
  /\bdispatch\s+is\s+running\b/i,
  /\btask\s+status\s*[:=]/i,
  /\bhead(?:RefOid)?\s*[:=]\s*[0-9a-f]{7,40}\b/i,
  /\bmergeable\s*[:=]/i,
  /\b(?:running|dispatched|ready|blocked)\s+tasks?\s*[:=]\s*\d+/i,
];

function validateDecision(d) {
  const errors = [];
  if (!d || typeof d !== 'object' || Array.isArray(d)) return ['decision must be a JSON object'];
  for (const k of ['ts', 'kind', 'content', 'source']) {
    if (!(k in d)) errors.push(`missing field: ${k}`);
  }
  if (d.ts && Number.isNaN(Date.parse(d.ts))) errors.push('ts must be an ISO-8601 timestamp');
  if (d.kind && !KINDS.includes(d.kind)) errors.push(`kind must be one of: ${KINDS.join(', ')}`);
  if (d.source && !SOURCES.includes(d.source)) errors.push(`source must be one of: ${SOURCES.join(', ')}`);
  if (typeof d.content === 'string') {
    if (!d.content.trim()) errors.push('content must not be empty');
    if (Buffer.byteLength(d.content, 'utf8') > DECISION_MAX_BYTES) {
      errors.push(`content exceeds ${DECISION_MAX_BYTES} bytes (one sentence per decision)`);
    }
    for (const re of CLASS_A_PATTERNS) {
      if (re.test(d.content)) {
        errors.push(`content looks like class-A pipeline state (${re}); decisions are what someone chose, not where the pipeline is`);
      }
    }
  } else if ('content' in d) {
    errors.push('content must be a string');
  }
  if ('related' in d) {
    const r = d.related;
    if (r !== null && (typeof r !== 'object' || Array.isArray(r))) errors.push('related must be an object or null');
    if (r && typeof r === 'object') {
      for (const k of Object.keys(r)) if (!['pr', 'issue', 'task'].includes(k)) errors.push(`related.${k} is not a known key`);
    }
  }
  return errors;
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);   // atomic on the same filesystem: the old file stays intact on a crash
  return Buffer.byteLength(text, 'utf8');
}

/** Append one decision. Validates first; a rejected line is never written. */
function appendDecision(d) {
  const errors = validateDecision(d);
  if (errors.length) return { ok: false, errors };
  const line = JSON.stringify(d) + '\n';
  fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
  fs.appendFileSync(JOURNAL, line);   // append-only: never rewrite, never delete
  return { ok: true, bytes: Buffer.byteLength(line, 'utf8') };
}

/** Rewrite handoff.md. Refuses anything over the cap or missing a heading. */
function writeHandoff(text) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > HANDOFF_MAX_BYTES) {
    return { ok: false, errors: [`handoff is ${bytes} bytes; the cap is ${HANDOFF_MAX_BYTES}. Move detail to the journal (class B) or to a query (class A).`] };
  }
  const required = ['## Now', '## Next', '## Waiting on', '## Risks'];
  const missing = required.filter(h => !text.includes(h));
  if (missing.length) return { ok: false, errors: [`handoff is missing heading(s): ${missing.join(', ')}`] };
  const written = atomicWrite(HANDOFF, text);
  return { ok: true, bytes: written };
}

function readHandoff() {
  return fs.existsSync(HANDOFF) ? fs.readFileSync(HANDOFF, 'utf8') : null;
}

/** Last N decisions, newest last. A malformed line is reported, never silently dropped. */
function readDecisions(limit = 20) {
  if (!fs.existsSync(JOURNAL)) return { lines: [], malformed: [] };
  const raw = fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean);
  const malformed = [];
  const parsed = [];
  raw.forEach((l, i) => {
    try { parsed.push(JSON.parse(l)); } catch { malformed.push({ line: i + 1, text: l.slice(0, 80) }); }
  });
  return { lines: parsed.slice(-limit), malformed, total: parsed.length };
}

module.exports = {
  validateDecision, appendDecision, writeHandoff, readHandoff, readDecisions,
  JOURNAL, HANDOFF, HANDOFF_MAX_BYTES, DECISION_MAX_BYTES, KINDS, SOURCES,
};

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'show') {
    const h = readHandoff();
    console.log(h ? h : '(no handoff.md yet)');
    const d = readDecisions(10);
    console.log(`\njournal: ${d.total || 0} decisions, ${d.malformed.length} malformed`);
    for (const l of d.lines) console.log(`  ${l.ts} [${l.kind}/${l.source}] ${l.content}`);
  } else {
    console.log('usage: node src/checkpoint.js show');
  }
}
