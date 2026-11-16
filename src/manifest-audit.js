#!/usr/bin/env node
// manifest-audit.js — independent completeness audit of manifest/protected.json.
//
// For every zone it puts the manifest's own row count next to a count produced by a DIFFERENT
// method: repo zones from `git ls-files` (tracked + untracked, .gitignore respected), Hermes
// zones from a shell `find`. It also counts how many files each exclude pattern removes, so the
// gap between "all files under this path" and "the rows in the manifest" is explained, not
// assumed. Read-only.
//
//   node src/manifest-audit.js

const fs = require('fs');
const path = require('path');

const V2 = 'D:/code/orca-supervisor';
const REPO_ROOT = 'D:/code/design-system-viewer';
const HERMES = path.join(process.env.LOCALAPPDATA || '', 'hermes');

const EXCLUDES = ['node_modules', 'dist', '.git', '.vite', 'coverage'];
const REPO_INCLUDES = ['ORCHESTRATION.md', 'README.md', 'opencode.json', 'tools/orchestration', 'docs/orchestration', '.github', 'app'];

const guard = require('./guard/exec.js');

function sh(cmd, args, cwd) {
  const r = guard.run([cmd, ...args], { cwd, dryRun: false, timeout: 300000 });
  if (r.ok) return String(r.stdout || '').trim();
  if (r.decision && !r.decision.allow) return `DENIED(${r.decision.rule})`;
  return `ERROR: ${String(r.error || '').slice(0, 300)}`;
}

function inExcludedDir(p) {
  return p.split(/[\\/]/).some(seg => EXCLUDES.includes(seg));
}

function underInclude(rel) {
  return REPO_INCLUDES.some(inc => rel === inc || rel.startsWith(inc + '/'));
}

function gitCount(wt) {
  // tracked + untracked-but-not-ignored; this is the independent source for a git worktree
  const out = sh('git', ['-C', wt, 'ls-files', '--cached', '--others', '--exclude-standard'], wt);
  if (out.startsWith('ERROR')) return out;
  const files = out.split('\n').filter(Boolean);
  const kept = files.filter(f => underInclude(f.split('\\').join('/')) && !inExcludedDir(f));
  return { total_listed: files.length, under_include_after_excludes: kept.length };
}

function findCount(dir) {
  // a shell find, deliberately a different implementation from the builder's fs.walk
  const out = sh('find', [dir, '-type', 'f', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/dist/*', '-not', '-path', '*/.git/*', '-not', '-path', '*/.vite/*', '-not', '-path', '*/coverage/*'], dir);
  if (out.startsWith('ERROR')) return out;
  return { found_files: out.split('\n').filter(Boolean).length };
}

function excludedCounts() {
  const roots = [REPO_ROOT, 'C:/Users/user/orca/workspaces/design-system-viewer/proteus-5', path.join(HERMES, 'skills'), path.join(HERMES, 'hooks')];
  const res = {};
  for (const ex of EXCLUDES) {
    let n = 0;
    for (const r of roots) {
      if (!fs.existsSync(r)) continue;
      const out = sh('find', [r, '-type', 'd', '-name', ex], r);
      if (out.startsWith('ERROR')) continue;
      for (const d of out.split('\n').filter(Boolean)) {
        const c = sh('find', [d, '-type', 'f'], d);
        if (!c.startsWith('ERROR')) n += c.split('\n').filter(Boolean).length;
      }
    }
    res[ex] = n;
  }
  return res;
}

function main() {
  const m = JSON.parse(fs.readFileSync(path.join(V2, 'manifest/protected.json'), 'utf8'));
  const byZone = {};
  for (const f of m.files) byZone[f.zone] = (byZone[f.zone] || 0) + 1;

  const worktrees = m.dynamic.worktrees || [];
  const wtRoot = worktrees.find(w => w.includes('proteus-5'));
  const repoZones = [
    ['repo:root', REPO_ROOT],
    ['repo:proteus-5', wtRoot],
  ];
  const hermesZones = [
    ['hermes:skills', path.join(HERMES, 'skills')],
    ['hermes:hooks', path.join(HERMES, 'hooks')],
    ['hermes:kanban', path.join(HERMES, 'kanban')],
    // Added 2026-09-27 with the manifest rows: the orca-sup profile's own hooks sat outside every zone,
    // so the file that enforces the scope rules was invisible to this audit as well as to the checker.
    ['hermes:profile-hooks', path.join(HERMES, 'profiles', 'orca-sup', 'hooks')],
  ];

  console.log('ZONE TABLE — manifest rows vs an independent count');
  console.log('zone                 | manifest | independent | method');
  console.log('---------------------|----------|-------------|-------');
  let sum = 0;
  for (const [zone, wt] of repoZones) {
    if (!wt) continue;
    const g = gitCount(wt);
    const ind = typeof g === 'string' ? g : g.under_include_after_excludes;
    sum += byZone[zone] || 0;
    console.log(`${zone.padEnd(20)} | ${String(byZone[zone] || 0).padStart(8)} | ${String(ind).padStart(11)} | git ls-files (cached+others, exclude-standard)`);
  }
  for (const [zone, dir] of hermesZones) {
    if (!fs.existsSync(dir)) continue;
    const g = findCount(dir);
    const ind = typeof g === 'string' ? g : g.found_files;
    sum += byZone[zone] || 0;
    console.log(`${zone.padEnd(20)} | ${String(byZone[zone] || 0).padStart(8)} | ${String(ind).padStart(11)} | shell find -type f`);
  }
  for (const zone of ['hermes:config', 'hermes:soul', 'hermes:processes', 'hermes:cron-file', 'orca:settings']) {
    if (!byZone[zone]) continue;
    sum += byZone[zone];
    console.log(`${zone.padEnd(20)} | ${String(byZone[zone]).padStart(8)} | ${String(byZone[zone]).padStart(11)} | single named file (no second method needed)`);
  }

  // Every remaining zone the manifest declares, counted from the manifest itself. Without this the TOTAL
  // line silently stopped adding up the moment a new zone appeared — the build covers every Orca
  // worktree, so a worktree named `hermit` (2026-09-27) left 207 rows in no row of this table while the
  // table still looked complete. A zone with no independent method is still named: the gap is visible,
  // not assumed away.
  const accounted = new Set([
    ...repoZones.map(([z]) => z),
    ...hermesZones.map(([z]) => z),
    'hermes:config', 'hermes:soul', 'hermes:processes', 'hermes:cron-file', 'orca:settings',
  ]);
  for (const zone of Object.keys(byZone).filter(z => !accounted.has(z)).sort()) {
    sum += byZone[zone];
    console.log(`${zone.padEnd(20)} | ${String(byZone[zone]).padStart(8)} | ${String(byZone[zone]).padStart(11)} | manifest's own zone field (no independent count yet)`);
  }
  console.log(`TOTAL manifest rows  | ${String(m.files.length).padStart(8)} | sum of zones above = ${sum}`);

  console.log('\nEXCLUDED PATTERNS — how many files each one removes');
  const ex = excludedCounts();
  for (const [k, v] of Object.entries(ex)) console.log(`  ${k.padEnd(14)} : ${v} files`);
  console.log(`  (patterns recorded in manifest.excludes: ${JSON.stringify(m.excludes)})`);
  console.log(`  NOTE: these are counts of files REMOVED from the walk, not rows in the manifest.`);
}

main();
