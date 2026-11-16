#!/usr/bin/env node
// prune-dryrun.js — run the pruning design (docs/pruning-design.md) in DRY-RUN mode against one skill.
//
// It implements step 1 (snapshot before anything) and step 2 (dry run) of the design, and stops
// there: steps 3-5 (apply on approval, verify) are deliberately not implemented, because applying is
// a separate approved action that goes through skills.write_approval.
//
// It writes exactly two things, both outside any skill:
//   backups/skills/<ts>/<skill>/   the snapshot (so nothing is ever deleted without bytes in git)
//   proposals/prune-<date>.md      the decision document
// It never writes a skill file. That is asserted at the end of the run.
//
// Classification order matters and is documented here because the order IS the policy:
//   1. fenced block      -> demote   (a command reference is useful, just not every turn)
//   2. names a path/number/backticked tool -> keep  (removing it would lose a trigger)
//   3. exact duplicate   -> drop
//   4. same 3-word opener as another line -> distil
//   5. long line (>100)  -> demote
//   6. otherwise         -> keep
const fs = require('fs');
const path = require('path');

const V2 = 'D:/code/orca-supervisor';
const PROFILE_SKILLS = path.join(process.env.LOCALAPPDATA, 'hermes', 'profiles', 'orca-sup', 'skills');

const skillName = process.argv[2];
if (!skillName) { console.error('usage: node src/prune-dryrun.js <orca-sup-skill-name>'); process.exit(2); }
if (!/^orca-sup-/.test(skillName)) { console.error('refusing: only orca-sup-* skills are in scope'); process.exit(2); }
if (skillName === 'orca-sup-runbook') {
  console.error('refusing: orca-sup-runbook is excluded from automatic distillation (pinned rule file)');
  process.exit(2);
}

const skillPath = path.join(PROFILE_SKILLS, skillName, 'SKILL.md');
if (!fs.existsSync(skillPath)) { console.error(`no such skill: ${skillPath}`); process.exit(2); }
const original = fs.readFileSync(skillPath, 'utf8');
const before = Buffer.from(original, 'utf8');

// --- step 1: snapshot first, unconditionally -------------------------------------------------
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const snapDir = path.join(V2, 'backups', 'skills', ts, skillName);
fs.mkdirSync(snapDir, { recursive: true });
fs.writeFileSync(path.join(snapDir, 'SKILL.md'), before);
const snapSha = require('crypto').createHash('sha256').update(before).digest('hex');

// --- step 2: dry run ------------------------------------------------------------------------
const lines = original.split('\n');
const seen = new Map();
const opener = (l) => l.trim().replace(/^[-*]\s+/, '').split(/\s+/).slice(0, 3).join(' ').toLowerCase();
const openers = new Map();
lines.forEach((l, i) => { if (l.trim()) openers.set(opener(l), (openers.get(opener(l)) || 0) + 1); });

let inFence = false;
const decisions = [];
lines.forEach((line, i) => {
  const n = i + 1;
  const t = line.trim();
  if (/^```/.test(t)) { inFence = !inFence; decisions.push({ n, verb: 'keep', line, why: 'fence delimiter' }); return; }
  if (!t) { decisions.push({ n, verb: 'keep', line, why: 'blank line' }); return; }
  if (inFence) { decisions.push({ n, verb: 'demote', line, why: 'inside a fenced command reference: useful, not needed every turn' }); return; }
  if (/^(---|#|##|---)/.test(t)) { decisions.push({ n, verb: 'keep', line, why: 'frontmatter or heading: structure' }); return; }
  if (/[A-Za-z]:\/|\b[\w./-]+\.(js|md|json|py|sh)\b|`[^`]+`|\b\d+\b/.test(t)) {
    decisions.push({ n, verb: 'keep', line, why: 'names a path, a file, a backticked tool or a number' });
    return;
  }
  if (seen.has(t)) { decisions.push({ n, verb: 'drop', line, why: `exact duplicate of line ${seen.get(t)}` }); return; }
  seen.set(t, n);
  if ((openers.get(opener(t)) || 0) > 1) {
    decisions.push({ n, verb: 'distil', line, why: `shares its opening words with another line ("${opener(t)}…")` });
    return;
  }
  if (t.length > 100) { decisions.push({ n, verb: 'demote', line, why: 'long line: candidate for the on-demand reference' }); return; }
  decisions.push({ n, verb: 'keep', line, why: 'no candidate reason found' });
});

const counts = decisions.reduce((a, d) => (a[d.verb] = (a[d.verb] || 0) + 1, a), {});
const date = new Date().toISOString().slice(0, 10);
const out = path.join(V2, 'proposals', `prune-${date}-${skillName}.md`);
fs.mkdirSync(path.dirname(out), { recursive: true });

const doc = [];
doc.push(`# Prune proposal (DRY RUN) — ${skillName}`);
doc.push('');
doc.push(`Snapshot (taken before anything): \`backups/skills/${ts}/${skillName}/SKILL.md\``);
doc.push(`Skill sha256 before: \`${snapSha}\`  ·  ${before.length} bytes, ${lines.length} lines`);
doc.push('');
doc.push('This document proposes; it applies nothing. Applying goes through `skills.write_approval: true`');
doc.push('and a human decision. No skill file was written by this run.');
doc.push('');
doc.push('## Decisions');
doc.push('');
doc.push('| line | verb | why |');
doc.push('|------|------|-----|');
for (const d of decisions) if (d.verb !== 'keep') doc.push(`| ${d.n} | **${d.verb}** | ${d.why} |`);
doc.push('');
doc.push('## What each verb would mean');
doc.push('');
for (const verb of ['drop', 'distil', 'demote']) {
  const rows = decisions.filter(d => d.verb === verb);
  if (!rows.length) continue;
  doc.push(`### ${verb} (${rows.length})`);
  doc.push('');
  for (const r of rows) doc.push(`- line ${r.n}: \`${r.line.trim().slice(0, 110)}\``);
  doc.push('');
}
doc.push('## Kept, with the reason that protects them');
doc.push('');
for (const r of decisions.filter(d => d.verb === 'keep' && d.why !== 'blank line')) doc.push(`- line ${r.n}: ${r.why}`);
doc.push('');
doc.push(`## Size`);
doc.push('');
doc.push(`Would shrink by ${counts.drop || 0} dropped + ${counts.distil || 0} distilled lines, and move`);
doc.push(`${counts.demote || 0} line(s) to the on-demand reference. Kept: ${counts.keep || 0}.`);
doc.push('');
doc.push(`Generated by \`src/prune-dryrun.js\`. The scheduled equivalent is not created (B3 d install awaits approval).`);

fs.writeFileSync(out, doc.join('\n'));

// --- assertion: no skill file was touched ----------------------------------------------------
const after = fs.readFileSync(skillPath);
if (Buffer.compare(before, after) !== 0) {
  console.error('FAIL: the skill file changed during a dry run — this must never happen');
  process.exit(1);
}

console.log(`skill      : ${skillName} (${before.length} bytes, ${lines.length} lines)`);
console.log(`snapshot   : backups/skills/${ts}/${skillName}/SKILL.md  sha256 ${snapSha.slice(0, 16)}…`);
console.log(`proposal   : ${out}`);
console.log(`decisions  : ${JSON.stringify(counts)}`);
console.log(`skill file : UNCHANGED (asserted by byte comparison after the run)`);
