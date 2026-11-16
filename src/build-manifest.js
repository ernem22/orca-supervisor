#!/usr/bin/env node
// build-manifest.js — build manifest/protected.json, the untouchable set.
//
// Source of the list: D:/code/orca-supervisor/docs/TASKS.md section 2 ("Untouchables").
// READ-ONLY. This script may only run the read-only commands allowed by section 3.
// It never writes outside D:/code/orca-supervisor/.
//
// Usage:
//   node src/build-manifest.js                 # write manifest/protected.json
//   node src/build-manifest.js --stdout        # print only (used by verify-untouched)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const V2 = 'D:/code/orca-supervisor';
const REPO_ROOT = 'D:/code/design-system-viewer';
const HERMES = path.join(process.env.LOCALAPPDATA || '', 'hermes');

// node_modules/dist/.git are derived artefacts: hashing them would make the manifest huge and
// would flag every `npm ci` as an external change. Excluded deliberately, and recorded in the
// manifest's `excludes` so the omission is visible rather than silent.
//
// `.locks` is excluded for a different reason: it holds runtime lock files
// (hermes/skills/.locks/*.lock) created and deleted by whoever is holding a skill write. They are not
// protected content, so they are excluded outright rather than marked volatile — volatile means "we
// protect this and expect it to change", and these are not protected at all.
const EXCLUDES = ['node_modules', 'dist', '.git', '.vite', 'coverage', '.locks'];

// The repo-side untouchable paths (section 2), relative to a worktree/repo root.
const REPO_INCLUDES = [
  'ORCHESTRATION.md',
  'README.md',
  'opencode.json',
  'tools/orchestration',
  'docs/orchestration',
  '.github',
  'app',
];

// Volatile: runtime files that change by design. They are still hashed and still printed — they
// just do not fail the run. Everything else stays static and FAILS, because a change there is
// either a real edit worth seeing or an event worth investigating.
const VOLATILE = [
  /\/\.curator_ledger\.jsonl$/,
  /\/\.usage\.json$/,
  /\/processes\.json$/,
  /\/kanban\/\.dispatcher\.lock$/,
  // Hook logs. The scope-guard appends one line per tool call, so a hooks row reported CHANGED on every
  // single check — measured on the first verify-untouched run after the profile-hooks zone was added. The
  // row stays protected (a change is printed as VOLATILE, never silent); it just cannot be a static
  // failure, because "the guard was called" is not an edit.
  /\/hooks\/.*\.log$/,
];

function walk(abs, out, relBase, seen) {
  seen = seen || new Set();
  let st;
  try { st = fs.lstatSync(abs); } catch { return; }
  if (st.isSymbolicLink()) {
    // A symlinked skill directory used to be skipped entirely, so its contents were outside the
    // protected set while the manifest still looked complete. Resolve it instead: a directory link
    // is walked (with a cycle guard), a file link is recorded with its target and the hash of the
    // RESOLVED content, and a broken link is recorded as broken rather than dropped.
    let target = null, tst = null;
    try { target = fs.realpathSync(abs); tst = fs.statSync(abs); } catch { /* broken */ }
    if (!target || !tst) {
      out.push({ abs, rel: path.relative(relBase, abs).split(path.sep).join('/'), size: 0, mtime: st.mtimeMs, broken_symlink: true });
      return;
    }
    if (tst.isDirectory()) {
      if (seen.has(target)) return;
      seen.add(target);
      const before = out.length;
      for (const e of fs.readdirSync(target)) walk(path.join(target, e), out, relBase, seen);
      for (let i = before; i < out.length; i++) out[i].via_symlink = abs.split(path.sep).join('/');
      return;
    }
    out.push({
      abs, rel: path.relative(relBase, abs).split(path.sep).join('/'),
      size: tst.size, mtime: tst.mtimeMs, symlink_target: target.split(path.sep).join('/'),
    });
    return;
  }
  if (st.isDirectory()) {
    const base = path.basename(abs);
    if (EXCLUDES.includes(base)) return;
    for (const e of fs.readdirSync(abs)) walk(path.join(abs, e), out, relBase);
    return;
  }
  if (!st.isFile()) return;
  out.push({ abs, rel: path.relative(relBase, abs).split(path.sep).join('/'), size: st.size, mtime: st.mtimeMs });
}

function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

const guard = require('./guard/exec.js');

// Every process this file starts goes through the single exit gate (A1 requirement). `sh()`
// keeps its old string contract so call sites did not have to change.
function sh(cmd, args, cwd) {
  const r = guard.run([cmd, ...args], { cwd, dryRun: false, timeout: 120000 });
  if (r.ok) return String(r.stdout || '').trim();
  if (r.decision && !r.decision.allow) return `DENIED(${r.decision.rule}): ${r.decision.reason}`;
  return `ERROR: ${String(r.error || '').slice(0, 400)}`;
}

function addTree(manifest, label, abs) {
  const rows = [];
  walk(abs, rows, abs);
  rows.sort((a, b) => a.rel.localeCompare(b.rel));
  for (const r of rows) {
    const row = {
      zone: label,
      path: r.abs.split(path.sep).join('/'),
      rel: r.rel,
      size: r.size,
      mtime_ms: Math.round(r.mtime),
      sha256: hashFile(r.abs),
    };
    if (r.symlink_target) row.symlink_target = r.symlink_target;
    if (r.via_symlink) row.via_symlink = r.via_symlink;
    if (r.broken_symlink) row.broken_symlink = true;
    manifest.files.push(row);
  }
  return rows.length;
}

// Pure helper: paths protected by the previous manifest that the current set no longer covers.
function missingZones(prevWorktrees, curWorktrees) {
  const cur = new Set(curWorktrees);
  return (prevWorktrees || []).filter(w => !cur.has(w));
}

function main() {
  const stdoutOnly = process.argv.includes('--stdout');
  const manifest = {
    built_at_utc: new Date().toISOString(),
    built_by: 'build-manifest.js',
    tasks_md_sha256: null,
    excludes: EXCLUDES,
    zones: [],
    files: [],
    dynamic: {},
  };

  // 1. The job file itself: its hash is the anchor for "did my instructions change".
  const tasksMd = path.join(V2, 'docs/TASKS.md');
  if (fs.existsSync(tasksMd)) manifest.tasks_md_sha256 = hashFile(tasksMd);

  // 2. Hermes main profile (section 2).
  const hermesPaths = [
    ['hermes:config', path.join(HERMES, 'config.yaml')],
    ['hermes:soul', path.join(HERMES, 'SOUL.md')],
    ['hermes:memory', path.join(HERMES, 'MEMORY.md')],
    ['hermes:user', path.join(HERMES, 'USER.md')],
    ['hermes:processes', path.join(HERMES, 'processes.json')],
  ];
  for (const [label, p] of hermesPaths) {
    if (!fs.existsSync(p)) continue;
    const st = fs.statSync(p);
    manifest.files.push({
      zone: label, path: p.split(path.sep).join('/'), rel: path.basename(p),
      size: st.size, mtime_ms: Math.round(st.mtimeMs), sha256: hashFile(p),
    });
  }
  for (const [label, sub] of [
    ['hermes:skills', 'skills'],
    ['hermes:hooks', 'hooks'],
    ['hermes:kanban', 'kanban'],
    // The orca-sup profile's own hooks. They were declared nowhere: `hermes:hooks` covers the main
    // profile's hooks directory only, so the file that ENFORCES every scope rule (and the carve-out
    // file's reader) sat outside the baseline — invisible to verify-untouched, which is a blind spot
    // in exactly the place the audit matters most.
    ['hermes:profile-hooks', path.join('profiles', 'orca-sup', 'hooks')],
  ]) {
    const abs = path.join(HERMES, sub);
    if (fs.existsSync(abs)) { addTree(manifest, label, abs); manifest.zones.push(label); }
  }

  // 3. Existing cron jobs: one hash per job, plus the file hash.
  const jobsFile = path.join(HERMES, 'cron/jobs.json');
  if (fs.existsSync(jobsFile)) {
    manifest.files.push({
      zone: 'hermes:cron-file', path: jobsFile.split(path.sep).join('/'), rel: 'jobs.json',
      size: fs.statSync(jobsFile).size, mtime_ms: Math.round(fs.statSync(jobsFile).mtimeMs), sha256: hashFile(jobsFile),
      // The file churns whenever a job RUNS (last_run_at, counters). Its content is not the
      // protected thing — the job DEFINITIONS are, and those are hashed per job below. So the
      // file row is runtime-volatile, and definition drift still fails.
      runtime_volatile: true,
    });
    try {
      const jobs = (JSON.parse(fs.readFileSync(jobsFile, 'utf8')).jobs) || [];
      // Definition = what the job IS. A change here is a real change and must FAIL.
      // `repeat` is deliberately in NEITHER list: it is a hybrid — `repeat.times` is definition,
      // `repeat.completed` increments on every run. Putting the whole object in the definition set
      // made every cron run report a false "definition changed" (caught by stability run 3).
      const DEF_FIELDS = ['name', 'prompt', 'script', 'schedule', 'enabled', 'deliver', 'workdir', 'skills', 'model', 'provider', 'base_url', 'no_agent', 'monitor_script', 'monitor_url', 'enabled_toolsets', 'attach_to_session', 'continuity', 'context_from'];
      // Runtime = what the job HAS DONE. A change here is normal operation and must NOT fail.
      const RT_FIELDS = ['last_run_at', 'next_run_at', 'last_status', 'last_error', 'last_delivery_error', 'last_delivery_unverified', 'failure_streak', 'last_dispatch', 'fire_claim', 'monitor_state', 'paused_at', 'paused_reason', 'state', 'provider_snapshot', 'model_snapshot', 'origin', 'created_at', 'schedule_display'];
      const pick = (o, keys) => { const r = {}; for (const k of keys) if (k in o) r[k] = o[k]; return r; };
      const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
      const defProj = (j) => {
        const r = pick(j, DEF_FIELDS);
        if (j.repeat && typeof j.repeat === 'object') r.repeat_times = j.repeat.times ?? null;
        return r;
      };
      const rtProj = (j) => {
        const r = pick(j, RT_FIELDS);
        if (j.repeat && typeof j.repeat === 'object') r.repeat_completed = j.repeat.completed ?? null;
        return r;
      };
      manifest.dynamic.cron_jobs = jobs.map(j => ({
        id: j.id, name: j.name,
        definition_sha256: sha(defProj(j)),
        runtime_sha256: sha(rtProj(j)),
      }));
      manifest.dynamic.cron_fields = { definition: DEF_FIELDS.concat(['repeat_times']), runtime: RT_FIELDS.concat(['repeat_completed']) };
    } catch (e) {
      manifest.dynamic.cron_jobs = `PARSE ERROR: ${e.message}`;
    }
  }

  // 4. Orca's own settings file. Hash-only — it can carry tokens, so no content and no key-by-key diff
  // is ever stored — and runtime-volatile, because Orca replaces it on its own schedule (measured: absent
  // for a moment mid-check, present minutes later). It carries the per-agent environment defaults, i.e.
  // the item 11 precondition, so an edit here is worth seeing. The shape of that edit is not our business.
  const orcaSettings = path.join(process.env.APPDATA || '', 'orca', 'profiles', 'local-default', 'orca-data.json');
  if (fs.existsSync(orcaSettings)) {
    const st = fs.statSync(orcaSettings);
    manifest.files.push({
      zone: 'orca:settings', path: orcaSettings.split(path.sep).join('/'), rel: 'orca-data.json',
      size: st.size, mtime_ms: Math.round(st.mtimeMs), sha256: hashFile(orcaSettings),
      runtime_volatile: true,
      note: 'hash-only, never content; known deliberate edit: settings.agentDefaultEnv.opencode = {} (the item 11 precondition, added 2026-09-25)',
    });
  }

  // 5. The repo and every Orca worktree (section 2: the repo AND all its worktrees).
  // Parse `orca worktree list --json`: the text table's column order differs between builds
  // (one form is `path sha [branch]`, another prefixes an id), and a regex over it silently
  // dropped every worktree except the root on the first run. JSON is the stable interface.
  const worktrees = [];
  try {
    const wj = JSON.parse(sh('orca', ['worktree', 'list', '--json'], REPO_ROOT));
    for (const w of ((wj.result || {}).worktrees || [])) {
      const p = (w.path || '').split('\\').join('/');
      if (p) worktrees.push(p);
    }
  } catch (e) {
    manifest.dynamic.worktree_parse_error = String(e.message);
  }
  if (!worktrees.includes(REPO_ROOT)) worktrees.unshift(REPO_ROOT);

  // `orca worktree list` returns every repo Orca knows, not just this one. Section 2 protects
  // "the design-system-viewer repo and all its worktrees", so other projects are filtered out.
  const scoped = worktrees.filter(w => w.includes('design-system-viewer'));
  if (scoped.length) { worktrees.length = 0; worktrees.push(...scoped); }
  if (!worktrees.includes(REPO_ROOT)) worktrees.unshift(REPO_ROOT);

  // A test seam, and the only way to prove the guard below without dismantling a real worktree:
  //   SUP_SIMULATE_MISSING_ZONE=<path> node src/build-manifest.js --stdout
  // It removes that path from the set exactly as a failed `worktree list` would.
  const simulated = process.env.SUP_SIMULATE_MISSING_ZONE;
  if (simulated) {
    const i = worktrees.indexOf(simulated);
    if (i > -1) worktrees.splice(i, 1);
    else worktrees.push(simulated + ' (simulated, never present)');
  }

  // LOUD FAILURE, not silent substitution. The first version of this file quietly fell back to
  // the repo root when the worktree list failed to parse, and produced a manifest that looked
  // complete with proteus-5 missing. A zone that was protected before must never disappear
  // without the operator saying so.
  const prevPath = path.join(V2, 'manifest/protected.json');
  if (fs.existsSync(prevPath)) {
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(prevPath, 'utf8')); } catch { prev = null; }
    const gone = missingZones((prev && prev.dynamic && prev.dynamic.worktrees) || [], worktrees);
    if (gone.length && !process.argv.includes('--allow-zone-loss')) {
      console.error(`build-manifest: REFUSING TO WRITE — protected worktree zone(s) missing: ${gone.join(', ')}`);
      console.error('  The previous manifest protected these paths; a manifest without them would look complete');
      console.error('  while silently dropping coverage. Re-run with --allow-zone-loss if this is intended.');
      process.exit(3);
    }
  }

  manifest.dynamic.worktrees = worktrees;
  manifest.zones.push('repo');
  for (const wt of worktrees) {
    const label = wt === REPO_ROOT ? 'repo:root' : `repo:${path.basename(wt)}`;
    let n = 0;
    for (const inc of REPO_INCLUDES) {
      const abs = path.join(wt, inc);
      if (!fs.existsSync(abs)) continue;
      const st = fs.statSync(abs);
      if (st.isDirectory()) n += addTree(manifest, label, abs);
      else manifest.files.push({
        zone: label, path: abs.split(path.sep).join('/'), rel: inc,
        size: st.size, mtime_ms: Math.round(st.mtimeMs), sha256: hashFile(abs),
      });
    }
    manifest.zones.push(`${label}(${n} files)`);
  }

  // 5. Dynamic state: git, GitHub (GET only), Orca counts. These are NOT hashed rows; they are
  // the baseline a later step compares against to detect external change.
  manifest.dynamic.git = {};
  for (const wt of worktrees) {
    manifest.dynamic.git[wt] = {
      head: sh('git', ['-C', wt, 'rev-parse', 'HEAD']),
      branch: sh('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD']),
      porcelain: sh('git', ['-C', wt, 'status', '--porcelain']),
    };
  }
  manifest.dynamic.remote_branches = sh('git', ['-C', REPO_ROOT, 'branch', '-r', '--format=%(refname:short) %(objectname)']);
  manifest.dynamic.gh_prs_open = sh('gh', ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,headRefOid,mergeable,baseRefName'], REPO_ROOT);
  manifest.dynamic.gh_labels = sh('gh', ['label', 'list', '--limit', '100', '--json', 'name'], REPO_ROOT);
  manifest.dynamic.gh_protection = sh('gh', ['api', 'repos/ernem22/design-system-viewer/branches/refactor%2Ffull-react-migration/protection'], REPO_ROOT);
  manifest.dynamic.orca_version = sh('orca', ['--version'], REPO_ROOT);
  manifest.dynamic.orca_worktrees = sh('orca', ['worktree', 'list'], REPO_ROOT);
  manifest.dynamic.orca_terminals = sh('orca', ['terminal', 'list', '--json'], REPO_ROOT);
  manifest.dynamic.orca_tasks = sh('orca', ['orchestration', 'task-list', '--json'], REPO_ROOT);
  manifest.dynamic.orca_workers = sh('orca', ['orchestration', 'worker-list', '--run', 'run_4e539259ab29', '--json'], REPO_ROOT);

  // Mark the runtime files that change by design, so the verifier can report them separately.
  for (const f of manifest.files) if (VOLATILE.some(re => re.test(f.path))) f.volatile = true;

  manifest.summary = {
    file_count: manifest.files.length,
    total_bytes: manifest.files.reduce((a, f) => a + f.size, 0),
  };

  const json = JSON.stringify(manifest, null, 1);
  if (stdoutOnly) { process.stdout.write(json); return; }
  const out = path.join(V2, 'manifest/protected.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, json);
  console.log(`manifest written: ${out}`);
  console.log(`files: ${manifest.summary.file_count}  total bytes: ${manifest.summary.total_bytes}`);
  console.log(`zones: ${manifest.zones.length}`);
  console.log(`tasks.md sha256: ${manifest.tasks_md_sha256}`);
}

// Importable for tests; runs as a script when invoked directly.
if (require.main === module) main();
module.exports = { missingZones, VOLATILE, EXCLUDES };
