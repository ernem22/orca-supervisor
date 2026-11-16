#!/usr/bin/env node
// adapters/opencode.js — the SECONDARY signal source: reading an OpenCode terminal's screen.
//
// Why this is isolated here: the primary signal is Orca's own projection (liveness/attention/
// nextAction), and screen reading is a fallback for the cases the projection cannot settle. Another
// harness (a different agent TUI) gets its own adapter rather than a branch inside the classifier.
//
// Everything this returns is a FACT about the screen text. It makes no classification and proposes no
// action — a screen is the weakest evidence in the system, and the classifier decides what, if
// anything, it is allowed to authorise.
//
// The observed shapes, recorded during the sessions that produced them:
//   "81.5K/8%"                 a progress counter; frozen means the SAME value across samples
//   "⬝⬝⬝⬝⬝⬝⬝⬝"               the idle bar: the turn ended and nothing is streaming
//   "Cannot connect to API"    a transport failure, not a rate limit
//   "stream error"             ditto, usually several in a row before the connection error
//   a question ending in "?"   often a permission/authority request awaiting a human
const LINES = (screen) => String(screen || '').split('\n').map(l => l.replace(/\s+$/, ''));

/** The progress counter, if the screen shows one. */
function progressCounter(screen) {
  const m = /(\d+(?:\.\d+)?[KMG]?)\s*\/\s*(\d+)%/.exec(String(screen || ''));
  if (!m) return null;
  return { raw: m[0], tokens: m[1], percent: Number(m[2]) };
}

/** Did the last visible turn end? Two markers, because the agent's own UI changed between versions:
 *  the pipeline's workers showed an idle bar (`⬝⬝⬝⬝`), and opencode 1.18.32 instead ends on a status
 *  line carrying the elapsed time (`▣ Build · GLM-5.3-Flash · 9.3s`). A live turn shows a spinner or a
 *  running timer. The sandbox drill is what surfaced the second shape — no fixture had it.
 */
function turnState(screen) {
  const lines = LINES(screen).filter(Boolean);
  const tail = lines.slice(-6).join('\n');
  const idleBar = /[⬝▪·]{4,}/.test(tail);
  const spinner = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(tail);
  const timer = /\b\d+[smh]\s*·|\besc to interrupt\b/i.test(tail);
  const finishedStatusLine = /·\s*\d+(?:\.\d+)?\s*(?:ms|s)\b/.test(tail) && !spinner && !timer;
  // Third marker, and the one this opencode build actually presents: the footer shows a Build line and
  // nothing is spinning or timing. A LIVE turn carries the same line plus a spinner or an interrupt
  // hint, so requiring their absence is what separates "working" from "finished".
  const idleFooter = /Build\s*·/.test(tail) && !spinner && !timer;
  return { ended: (idleBar || finishedStatusLine || idleFooter) && !spinner, idleBar, finishedStatusLine, idleFooter, spinner, timer };
}

/** Error strings seen in practice, kept literal so a fixture can be matched exactly.
 *
 *  The numeric codes require a status/HTTP context. A bare `429` matched any screen containing those
 *  digits — a hash, a byte counter, a port — and the sandbox drill caught a worker being called
 *  rate-limited with no rate limit anywhere in sight. Same class of mistake as the worker_done word
 *  match: a pattern loose enough to match incidental text is not a detector.
 */
const ERROR_PATTERNS = [
  { kind: 'transport', re: /Cannot connect to API|stream error|Failed to fetch|ECONNRESET|socket hang up/i },
  { kind: 'rate_limit', re: /rate limit|too many requests|quota exceeded|(?:status|HTTP)[^\n]{0,12}\b429\b|\b429\b[^\n]{0,12}(?:too many|rate)/i },
  { kind: 'auth', re: /unauthorized|invalid api key|authentication failed|(?:status|HTTP)[^\n]{0,12}\b401\b|\b401\b[^\n]{0,12}unauthorized/i },
];

function errors(screen) {
  const text = String(screen || '');
  const found = [];
  for (const p of ERROR_PATTERNS) {
    const m = text.match(new RegExp(p.re.source, 'gi'));
    if (m) found.push({ kind: p.kind, count: m.length, first: m[0] });
  }
  return found;
}

/** A question that looks like it is waiting for a human.
 *
 *  The REAL prompt (opencode 1.18.32) is not a question and contains no "?" at all — it is a bordered
 *  block:
 *      △ Permission required
 *        ← Access external directory D:\code\sup-sandbox
 *      Allow once   Allow always   Reject
 *  Requiring a "?" missed every real occurrence, and matching the bare word "allow" anywhere would match
 *  a prompt echo. So the primary match is the block's own vocabulary: a permission header AND the choice
 *  row together. That is specific to the event, which is the whole point (rule 7).
 */
function permissionQuestion(screen) {
  const text = String(screen || '');
  if (/Permission required/i.test(text) && /Allow once|Allow always/i.test(text)) {
    const subject = (text.match(/←[^\n]{0,80}/) || [''])[0].trim();
    return `permission prompt${subject ? ': ' + subject : ''}`;
  }
  // A question that explicitly asks for authority — the weaker form, kept as a fallback.
  const lines = LINES(text).filter(Boolean).slice(-20);
  for (const l of lines) {
    if (/\?\s*$/.test(l) && /(allow|permission|authoriz|approve|may i|should i|yetki|izin)/i.test(l)) return l.trim();
  }
  return null;
}

/** The worker's own statement that it finished — the strongest signal a screen can carry.
 *
 *  It must be the COMMAND, not the word. A naive /worker_done/ test matched the prompt echo: a spec
 *  that says "Do NOT send worker_done" contains the string, so every worker told not to report looked
 *  like one that had. The drill caught this on a real sandbox worker; the fixtures never could, because
 *  no fixture contained an instruction about worker_done.
 */
function workerDone(screen) {
  const text = String(screen || '');
  // The hook is invoked as an orca command; require that shape, on one line.
  if (/(?:orca\s+orchestration\s+send|--type[= ]+worker_done|worker_done\s+body\s*:)/i.test(text)) return true;
  // A tool-call receipt the hook itself leaves behind.
  if (/\bworker_done\b[^\n]{0,40}\b(delivered|accepted|acknowledged|sent)\b/i.test(text)) return true;
  return false;
}

function read(screen) {
  return {
    counter: progressCounter(screen),
    turn: turnState(screen),
    errors: errors(screen),
    permission_question: permissionQuestion(screen),
    worker_done: workerDone(screen),
    lines: LINES(screen).length,
  };
}

module.exports = { read, progressCounter, turnState, errors, permissionQuestion, workerDone, ERROR_PATTERNS };
