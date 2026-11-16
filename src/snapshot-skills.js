#!/usr/bin/env node
// snapshot-skills.js — copy skill content into the v2 zone so a rewrite stays recoverable.
//
// The curator rewrote SKILL.md and the pre-patch content was NOT recoverable (no tar.gz backup
// existed on this machine). This keeps a copy inside D:/code/orca-supervisor/backups/skills/<ts>/
// so the next such rewrite can be diffed. Read-only with respect to the Hermes home.
//
//   node src/snapshot-skills.js                       # snapshot the pipeline skill now
//   node src/snapshot-skills.js --from-manifest <p> <rows.json>   # snapshot rows given by the verifier
const fs = require('fs');
const path = require('path');

const V2 = 'D:/code/orca-supervisor';
const H = path.join(process.env.LOCALAPPDATA || '', 'hermes');
const SKILL_ROOT = path.join(H, 'skills');

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z'); }

function copyTree(srcAbs, destRoot, relBase) {
  const out = [];
  (function walk(a) {
    let st; try { st = fs.lstatSync(a); } catch { return; }
    if (st.isSymbolicLink()) {   // follow: the orca-cli skill is a link and its content matters
      let t; try { t = fs.realpathSync(a); } catch { out.push({ path: a, broken: true }); return; }
      const ts = fs.statSync(a);
      if (ts.isDirectory()) { for (const e of fs.readdirSync(t)) walk(path.join(t, e)); return; }
      a = t;
    }
    if (fs.statSync(a).isDirectory()) { for (const e of fs.readdirSync(a)) walk(path.join(a, e)); return; }
    const rel = path.relative(relBase, a).split(path.sep).join('/');
    const dest = path.join(destRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(a, dest);
    out.push({ rel, bytes: fs.statSync(dest).size });
  })(srcAbs);
  return out;
}

function snapshotSkill(skillDirAbs, why) {
  const ts = stamp();
  const dest = path.join(V2, 'backups/skills', ts, path.basename(skillDirAbs));
  const files = copyTree(skillDirAbs, dest, skillDirAbs);
  const meta = { ts, source: skillDirAbs.split(path.sep).join('/'), reason: why, files };
  fs.writeFileSync(path.join(V2, 'backups/skills', ts, 'SNAPSHOT.json'), JSON.stringify(meta, null, 1));
  return { dir: path.join(V2, 'backups/skills', ts), count: files.length, files };
}

module.exports = { snapshotSkill, copyTree };

if (require.main === module) {
  const skillDir = path.join(SKILL_ROOT, 'autonomous-ai-agents/orca-opencode-worker-pipelines');
  const r = snapshotSkill(skillDir, process.argv.includes('--auto') ? 'verify-untouched: changed skill row' : 'manual snapshot');
  console.log(`snapshot: ${r.dir} (${r.count} files)`);
  for (const f of r.files) console.log(`  ${f.rel} | ${f.bytes} B`);
}
