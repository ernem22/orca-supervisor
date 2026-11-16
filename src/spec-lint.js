#!/usr/bin/env node
// src/spec-lint.js — D2's linter. It rejects a dispatch spec BEFORE it is sent to a worker.
//
// Why this exists: the last session produced ten verified spec errors — three specs derived by `sed`
// from another PR (so the numbers changed while the claims did not, and reviewer-123 wrote a verdict
// on the WRONG PR), two wrong ports, two unfilled placeholders, three skipped verdict-comment steps.
// Every one of those was invisible at dispatch time and expensive afterwards. A lint pass is the
// cheapest place to catch them.
//
// The rules are exactly the failure classes that actually happened, not a style guide:
//   1. an unfilled `<...>` placeholder
//   2. PR/issue numbers that disagree with the spec's own declared numbers
//   3. a port outside the reserved range
//   4. no verdict-comment step (the merge gate cannot see a verdict that was never posted)
//   5. no forbidden-actions block (a worker with no stated limits invents its own)
//   6. no acceptance block (the first lines of worker_done)
//
// Usage: node src/spec-lint.js <spec.md> [--issue N] [--pr N] [--port N] [--json]
const fs = require('fs');

// The reserved range. ORCHESTRATION.md says "4173 and after", and the pipeline has used 4223 — so an
// upper bound of 4221 (what reap.sh happens to scan) would reject a port the pipeline itself
// legitimately used. The bound here is a sanity cap, not the reservation.
const RESERVED_PORTS = { min: 4173, max: 4299 };

function lint(text, opts = {}) {
  const errors = [];
  const warnings = [];
  const add = (rule, detail, line) => errors.push({ rule, detail, line: line || null });

  const lines = text.split('\n');

  // 1. unfilled placeholders — but only the DISPATCH ones. A template also contains placeholders that
  //    are deliberately left in place because they describe the shape of the worker's own OUTPUT
  //    ("<one short line, only if fail>"). The real failure class was a dispatch parameter left empty
  //    (`<file set>` with nothing in it), so a placeholder is an error only before the output block
  //    begins, and a warning after it.
  let inOutputBlock = false;
  lines.forEach((l, i) => {
    // Case-sensitive on purpose: the templates write their headings in capitals, and a case-insensitive
    // match fired on the wrapped prose line "output is that one comment plus one report.", which made
    // every later placeholder look like part of the output shape.
    if (/^\s*(OUTPUT|OBSERVABLE ACCEPTANCE|ACCEPTANCE)\b/.test(l)) inOutputBlock = true;
    const m = /<[^<>\n]{1,140}>/.exec(l);
    if (!m) return;
    if (inOutputBlock) warnings.push({ rule: 'output-shape-placeholder', detail: `line ${i + 1}: ${m[0]} is part of the output shape, not a dispatch parameter`, line: i + 1 });
    else add('unfilled-placeholder', `dispatch placeholder left in the spec: ${m[0]}`, i + 1);
  });

  // 2. number consistency — the sed-derived class. Any number that names a PR or an issue must agree
  //    with the spec's declared numbers; a spec that says issue 112 and PR 123 while the body talks
  //    about 122 is the exact shape that put a verdict on the wrong PR.
  const declared = [];
  if (opts.issue) declared.push(Number(opts.issue));
  if (opts.pr) declared.push(Number(opts.pr));
  const seen = new Set();
  lines.forEach((l, i) => {
    // A number that NAMES a PR or an issue. The gap between the word and the number is deliberate:
    // "gh pr diff 122" is exactly how a spec references a PR, and a pattern that only matched
    // "PR 122" missed the sed-derived case that put a verdict on the wrong PR.
    for (const m of l.matchAll(/\b(?:PR|pr|pull request|issue|Issue)\b[^\d\n]{0,24}(\d{1,5})\b|\b#(\d{1,5})\b/g)) {
      const n = Number(m[1] || m[2]);
      if (!n) continue;
      seen.add(n);
      if (declared.length && !declared.includes(n)) {
        add('inconsistent-number', `spec names ${n} but declares ${declared.join('/')} — a spec derived from another PR looks exactly like this`, i + 1);
      }
    }
  });
  if (declared.length && seen.size === 0) {
    warnings.push({ rule: 'no-number-referenced', detail: 'the spec declares an issue/PR but the body never names one' });
  }

  // 3. port range
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/(?::|port\s+)(\d{4,5})\b/g)) {
      const p = Number(m[1]);
      if (p < 1000 || p > 65535) continue;
      if (p < RESERVED_PORTS.min || p > RESERVED_PORTS.max) {
        add('port-out-of-range', `port ${p} is outside the reserved range ${RESERVED_PORTS.min}-${RESERVED_PORTS.max}`, i + 1);
      }
    }
  });

  // 4. verdict-comment step — the marker AND the instruction to post it as a PR comment.
  if (!/dsv-verdict/.test(text)) {
    add('missing-verdict-step', 'no dsv-verdict marker: the merge gate reads a PR comment, and a verdict that was never posted does not exist');
  } else if (!/(post|comment)[^\n]{0,80}(PR|pull request)|(PR|pull request)[^\n]{0,80}(comment)/i.test(text)) {
    add('missing-verdict-step', 'the dsv-verdict marker is present but the spec never says to POST it as a PR comment');
  }

  // 5. forbidden-actions block
  const hasReadOnly = /read-only|read only/i.test(text);
  const hasDoNot = /do not\b/i.test(text);
  if (!hasReadOnly && !hasDoNot) {
    add('missing-forbidden-block', 'no forbidden-actions block (a "read-only" or "do not …" section): a worker with no stated limits invents its own');
  }

  // 6. acceptance block — the first lines of worker_done.
  const hasAcceptance = /(OBSERVABLE ACCEPTANCE|ACCEPTANCE)/i.test(text);
  const hasStatusLine = /\bstatus:\s*(pass|fail|ok|blocked)/i.test(text);
  const hasScopeOk = /\bscope_ok\s*:/i.test(text);
  if (!hasAcceptance && !hasStatusLine) {
    add('missing-acceptance-block', 'no acceptance block: the spec never states the first lines of worker_done, so the report shape is left to chance');
  } else if (hasAcceptance && !hasStatusLine && !hasScopeOk) {
    add('missing-acceptance-block', 'an acceptance heading exists but names none of the worker_done lines (status:/scope_ok:)');
  }

  return { ok: errors.length === 0, errors, warnings, rules: 6 };
}

module.exports = { lint, RESERVED_PORTS };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const file = argv.find(a => !a.startsWith('--'));
  if (!file) { console.error('usage: node src/spec-lint.js <spec.md> [--issue N] [--pr N] [--json]'); process.exit(2); }
  const num = (flag) => { const i = argv.indexOf(flag); return i > -1 ? argv[i + 1] : null; };
  const text = fs.readFileSync(file, 'utf8');
  const r = lint(text, { issue: num('--issue'), pr: num('--pr') });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }
  console.log(`spec-lint: ${file} — ${r.ok ? 'PASS' : `REJECT (${r.errors.length} error(s))`}`);
  for (const e of r.errors) console.log(`  [${e.rule}]${e.line ? ` line ${e.line}:` : ''} ${e.detail}`);
  for (const w of r.warnings) console.log(`  [warn:${w.rule}] ${w.detail}`);
  process.exit(r.ok ? 0 : 1);
}
