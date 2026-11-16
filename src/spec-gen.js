#!/usr/bin/env node
// src/spec-gen.js — D2's generator. It fills a spec template and refuses to emit an unfilled one.
//
// The generator's most important property is not what it fills but what it refuses: every generated
// spec is linted before it is written, so a spec with a leftover placeholder, a number that disagrees
// with its own header, an out-of-range port, a missing verdict step, a missing forbidden-actions block
// or a missing acceptance block CANNOT leave this program. The failure classes that cost the last
// session ten specs are rejected at the source rather than discovered by a reviewer three steps later.
//
// Templates live under templates/ (copied from the pipeline's docs/orchestration/specs/ — the
// originals are read-only source and are never modified).
//
// Usage:
//   node src/spec-gen.js --template reviewer --issue 121 --pr 130 --sha <sha> \
//        --set "the specific edge case this change is most likely to get wrong=a falsy zero" \
//        --out cycle-8/spec_reviewer_130.md
const fs = require('fs');
const path = require('path');
const { lint } = require(path.join(__dirname, 'spec-lint.js'));

const V2 = path.dirname(__dirname);
const TEMPLATES = path.join(V2, 'templates');

function parse(argv) {
  const o = { sets: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--template') o.template = argv[++i];
    else if (a === '--issue') o.issue = argv[++i];
    else if (a === '--pr') o.pr = argv[++i];
    else if (a === '--sha') o.sha = argv[++i];
    else if (a === '--port') o.port = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--set') { const kv = argv[++i] || ''; const j = kv.indexOf('='); if (j > 0) o.sets[kv.slice(0, j).trim()] = kv.slice(j + 1).trim(); }
  }
  return o;
}

/** Fill the template. Substitution is exact-match on the placeholder text, longest first, so a short
 *  placeholder can never eat the prefix of a longer one. */
function fill(text, o) {
  let out = text;
  const subs = [];
  if (o.issue) subs.push(['<n>', String(o.issue)]);
  if (o.pr) subs.push(['<pr>', String(o.pr)]);
  if (o.sha) subs.push(['<sha>', String(o.sha)]);
  if (o.port) subs.push(['<port>', String(o.port)]);
  for (const [k, v] of Object.entries(o.sets)) subs.push([`<${k}>`, v]);
  subs.sort((a, b) => b[0].length - a[0].length);
  const used = [];
  for (const [ph, val] of subs) {
    if (out.includes(ph)) { out = out.split(ph).join(val); used.push(ph); }
  }
  // A header block stating the dispatch parameters, so the port and the numbers are on the face of the
  // spec rather than buried in prose — the linter then checks them against the body.
  const head = [
    `DISPATCH PARAMETERS — issue ${o.issue || '?'} · PR ${o.pr || '?'} · port ${o.port || '?'} · commit ${o.sha || '?'}`,
    '',
  ].join('\n');
  return { text: head + out, used };
}

function main() {
  const o = parse(process.argv.slice(2));
  if (!o.template) { console.error('usage: node src/spec-gen.js --template <name> [--issue N] [--pr N] [--sha S] [--port P] [--set "<placeholder>=<value>"] [--out FILE]'); process.exit(2); }
  const file = path.join(TEMPLATES, `${o.template}.md`);
  if (!fs.existsSync(file)) {
    console.error(`spec-gen: no template ${o.template} under ${TEMPLATES} (have: ${fs.readdirSync(TEMPLATES).join(', ')})`);
    process.exit(2);
  }
  const { text, used } = fill(fs.readFileSync(file, 'utf8'), o);

  // The gate. Nothing is written unless the generated spec passes every lint rule.
  const r = lint(text, { issue: o.issue, pr: o.pr });
  if (!r.ok) {
    console.error(`spec-gen: REFUSING to emit — ${r.errors.length} lint error(s):`);
    for (const e of r.errors) console.error(`  [${e.rule}]${e.line ? ` line ${e.line}:` : ''} ${e.detail}`);
    console.error(`  (filled: ${used.join(', ') || 'nothing'})`);
    process.exit(1);
  }
  if (o.out) {
    fs.mkdirSync(path.dirname(o.out), { recursive: true });
    fs.writeFileSync(o.out, text);
    console.log(`spec-gen: wrote ${o.out} (${text.length} B) — lint PASS, ${used.length} placeholder(s) filled`);
  } else {
    process.stdout.write(text);
  }
}

if (require.main === module) main();
module.exports = { fill };
