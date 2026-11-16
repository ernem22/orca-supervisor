#!/usr/bin/env node
// src/snapshot.js — C1: the snapshot layer. ONE read-only observation of the world, as JSON.
//
// Contract: docs/snapshot-schema.md. Every command goes through src/guard/exec.js, so the guard's
// allow list is the only reason anything runs — if a command is not allowed, this records the denial
// as an error and keeps going rather than reaching around the gate. It never deletes, closes, aborts,
// reaps or writes anything outside state/snapshots/.
//
// A failed step is recorded in errors[] and never aborts the run: a snapshot that silently omitted a
// section would be worse than one that says it could not read it.
//
// Usage: node src/snapshot.js [--stdout] [--fixture <path>]
//   --stdout   print the document instead of writing it (for fixtures and tests)
//   --fixture  read command output from a directory of pre-recorded files instead of executing
//              anything (tests use this; fixtures are masked)
const fs = require('fs');
const path = require('path');
const guard = require(path.join(__dirname, 'guard/exec.js'));

const V2 = path.dirname(__dirname);
const WORKSPACE_ROOT = 'C:/Users/user/orca/workspaces/design-system-viewer';
const PORTS = Array.from({ length: 4221 - 4173 + 1 }, (_, i) => 4173 + i);

const argv = process.argv.slice(2);
const TO_STDOUT = argv.includes('--stdout');
const FIXTURE = (() => { const i = argv.indexOf('--fixture'); return i > -1 ? argv[i + 1] : null; })();

const errors = [];
const notes = [];
const CWD = V2;

/** Run through the gate. A denial or a non-zero exit is an error entry, never a thrown exception. */
function sh(command, step, timeout, lenient) {
  let a = Array.isArray(command) ? command : command.split(' ');
  // `gh` resolves the repository from the CWD's git remote, and the v2 workspace is not a clone of
  // the pipeline repo — without this, `gh pr list` returns "no git remotes found" and the whole
  // GitHub section comes back empty, which looks like "no open PRs" rather than "I could not ask".
  if (a[0] === 'gh' && ['pr', 'issue', 'repo'].includes(a[1]) && !a.includes('--repo') && !a.includes('-R')) {
    a = [a[0], a[1], a[2], '--repo', 'ernem22/design-system-viewer', ...a.slice(3)];
  }
  const r = guard.run(a, { cwd: CWD, dryRun: false, timeout: timeout || 120000 });
  if (!r.ok) {
    // `du` exits non-zero when it meets an unreadable path while still printing usable totals. A
    // lenient caller keeps that output and records a note; everything else treats failure as failure.
    if (lenient && r.stdout && String(r.stdout).trim()) {
      notes.push(`${step}: exited ${r.exit} but produced output; using it`);
      return String(r.stdout);
    }
    errors.push({ step, command: a.join(' '), error: r.error || (r.decision && r.decision.reason) || `exit ${r.exit}` });
    return null;
  }
  return r.stdout == null ? '' : String(r.stdout);
}

/** Fixture mode: read a recorded file instead of executing. Never silently empty — a missing fixture
 *  is an error, because an absent section must not look like an empty world. */
function shFixture(name, step) {
  const p = path.join(FIXTURE, name);
  try { return fs.readFileSync(p, 'utf8'); }
  catch (e) { errors.push({ step, command: `fixture:${name}`, error: e.message }); return null; }
}

const run = FIXTURE ? shFixture : sh;

function json(text, step) {
  if (text == null) return null;
  try { return JSON.parse(text); }
  catch (e) { errors.push({ step, command: '(parse)', error: `not JSON: ${e.message}` }); return null; }
}

/** Mask anything that looks like a credential. Applied to command lines and to fixture output.
 *  The pattern is deliberately tight: a loose `sk[-_]…` once matched the string `ta<sk_>terminal_pr_table`
 *  and rewrote a JSON KEY into `ta<masked>`, which is how a masker corrupts the very file it protects. */
const MASK = /\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9._-]{20,})\b/g;
const MASK_BEARER = /(Bearer\s+)[A-Za-z0-9._-]{10,}/g;
const mask = (s) => (s == null ? s : String(s).replace(MASK, '<masked>').replace(MASK_BEARER, '$1<masked>'));

// ---------------------------------------------------------------- 1. Orca
function orca() {
  const out = { version: null, run: null, tasks: [], dispatches: [], worker_pages: null, terminals: [], worktrees: [] };

  const ver = run(['orca', '--version'], 'orca.version');
  out.version = ver ? ver.trim().split('\n')[0] : null;

  const cur = json(run(['orca', 'orchestration', 'run-current', '--json'], 'orca.run-current'), 'orca.run-current');
  if (cur) {
    const r = (cur.result && cur.result.run) || {};
    out.run = { run_id: r.id || null, coordinator_handle: r.coordinator_handle || null };
  }

  const tl = json(run(['orca', 'orchestration', 'task-list', '--json'], 'orca.task-list'), 'orca.task-list');
  const tasks = (tl && (tl.result && tl.result.tasks || tl.tasks)) || [];
  // The field is `task_title`, not `title` — reading the wrong name produced 24 table rows with empty
  // titles, which looked like tasks that had no title rather than a wrong key.
  out.tasks = tasks.map(t => ({
    id: t.id,
    title: t.task_title || t.display_name || null,
    status: t.status,
    created_at: t.created_at || null,
    created_by_terminal: t.created_by_terminal_handle || null,
  }));
  if (tasks.length && out.tasks.every(t => t.title === null)) {
    notes.push('task-list returned records with no task_title/display_name; titles are null for all rows');
  }

  for (const t of out.tasks.filter(x => x.status === 'dispatched')) {
    const d = json(run(['orca', 'orchestration', 'dispatch-show', '--task', t.id, '--json'], `orca.dispatch-show:${t.id}`), 'orca.dispatch-show');
    const dd = d && (d.result && d.result.dispatch || d.dispatch);
    if (!dd) continue;

    // The projection lives on the WORKER, not on the dispatch. `dispatch-show` carries no `projection`
    // key at all — an earlier version read it from there, so every liveness/attention field was
    // undefined and silently fell back to a default. Measured: worker-show returns
    // projection.liveness.verdict and projection.attention.requiresAction; dispatch-show returns neither.
    const dispatchId = dd.dispatchId || dd.id || null;
    let p = dd.projection || {};
    if (!dd.projection && dispatchId) {
      const w = json(run(['orca', 'orchestration', 'worker-show', '--dispatch', dispatchId, '--json'], `orca.worker-show:${dispatchId}`), 'orca.worker-show');
      // MEASURED shape: the projection sits at `result.projection` — NOT under `result.dispatch` or
      // `result.worker`. Reading it from the wrong path returns an object with no projection and the
      // fields fall back to a default, which is precisely the bug this fix exists to remove. Walking the
      // tree for a `projection` key is how the real path was found, after two wrong guesses.
      const wd = w && w.result ? w.result : null;
      if (wd && wd.projection) p = wd.projection;
      else if (wd && wd.dispatch && wd.dispatch.projection) p = wd.dispatch.projection;
      else notes.push(`dispatch ${dispatchId}: worker-show returned no projection; liveness is unknown, not "live"`);
    }

    out.dispatches.push({
      task_id: t.id,
      dispatch_id: dispatchId,
      assignee_handle: dd.assignee_handle || null,
      liveness: (p.liveness && p.liveness.verdict) || null,
      attention: (p.attention && p.attention.categories) || null,
      requires_action: !!(p.attention && p.attention.requiresAction),
      next_action: (p.nextAction && p.nextAction.argv) || null,
      next_action_kind: (p.nextAction && p.nextAction.kind) || null,
      resource_state: (dd.resource && dd.resource.state) || null,
      projection_source: dd.projection ? 'dispatch-show' : (p && p.liveness ? 'worker-show' : null),
    });
  }

  // ALL pages via cursor. A truncated read is recorded as truncated rather than silently short.
  if (out.run && out.run.run_id) {
    let cursor = null, pages = 0, rows = 0, retained = null, truncated = false;
    do {
      const a = ['orca', 'orchestration', 'worker-list', '--run', out.run.run_id, '--json'];
      if (cursor) a.push('--cursor', cursor);
      const w = json(run(a, `orca.worker-list:page${pages + 1}`), 'orca.worker-list');
      if (!w) { truncated = true; break; }
      const res = w.result || w;
      const arr = res.workers || res.dispatches || [];
      rows += arr.length;
      if (res.counts && typeof res.counts.retained === 'number') retained = res.counts.retained;
      pages += 1;
      cursor = (res.page && res.page.hasMore && res.page.nextCursor) || null;
      if (pages >= 10) { truncated = true; break; }   // hard stop: never loop forever on a bad cursor
    } while (cursor);
    out.worker_pages = { pages, rows, counts_retained: retained, truncated };
    if (truncated) notes.push('worker-list stopped before exhausting pages; counts_retained is the true total');
  }

  const term = json(run(['orca', 'terminal', 'list', '--json'], 'orca.terminal-list'), 'orca.terminal-list');
  const terms = (term && (term.result && term.result.terminals || term.terminals)) || [];
  out.terminals = terms.map(t => ({ handle: t.handle || t.id, agent: t.agent || null, state: t.state || null, retained: !!t.retained }));

  const wt = json(run(['orca', 'worktree', 'list', '--json'], 'orca.worktree-list'), 'orca.worktree-list');
  const trees = (wt && (wt.result && wt.result.worktrees || wt.worktrees)) || [];
  out.worktrees = trees
    .filter(w => String(w.path || '').toLowerCase().includes('design-system-viewer'))
    .map(w => ({ path: w.path, branch: w.branch || null, display_name: w.displayName || null }));
  if (trees.length && out.worktrees.length !== trees.length) {
    notes.push(`worktree list returned ${trees.length} trees, ${out.worktrees.length} in design-system-viewer scope`);
  }
  return out;
}

// ---------------------------------------------------------------- 2. GitHub
function github() {
  const out = { prs: [], issues: [] };

  const prs = json(run(['gh', 'pr', 'list', '--state', 'open', '--limit', '20', '--json',
    'number,title,headRefOid,baseRefName,mergeable'], 'github.pr-list'), 'github.pr-list');

  // Only the PRs a dispatched task names are probed further. Each probe is two more `gh` calls, and an
  // unbounded loop over every open PR is what made the first live run exceed its budget. The set that
  // matters for the task↔terminal↔PR table is exactly the dispatched ones.
  const wanted = new Set();
  for (const t of ORCA_CACHE.tasks.filter(x => x.status === 'dispatched')) {
    const m = /\bPR\s*#?(\d+)\b|\b#(\d+)\b/i.exec(t.title || '');
    if (m) wanted.add(Number(m[1] || m[2]));
  }

  for (const p of prs || []) {
    const probe = wanted.has(p.number);
    let checks = null, verdict = null;
    if (probe) {
      const c = json(run(['gh', 'pr', 'checks', String(p.number), '--json', 'name,state'], `github.checks:${p.number}`, 30000), 'github.checks');
      if (Array.isArray(c)) {
        const states = [...new Set(c.map(x => x.state))];
        checks = states.length === 1 ? states[0] : states.join('+');
      }
      // The gate reads a verdict COMMENT, so its presence is recorded per PR.
      verdict = false;
      const v = json(run(['gh', 'pr', 'view', String(p.number), '--json', 'comments'], `github.verdict:${p.number}`, 30000), 'github.verdict');
      if (v && Array.isArray(v.comments)) verdict = v.comments.some(x => /dsv-verdict/.test(x.body || ''));
    } else {
      notes.push(`PR #${p.number} not probed for checks/verdict: no dispatched task names it (kept as a row, marked null)`);
    }
    out.prs.push({
      number: p.number, title: p.title, head_sha: p.headRefOid,
      base: p.baseRefName, mergeable: p.mergeable, checks_state: checks, verdict_comment: verdict,
    });
  }

  const iss = json(run(['gh', 'issue', 'list', '--state', 'open', '--limit', '20', '--json',
    'number,title,labels'], 'github.issue-list'), 'github.issue-list');
  out.issues = (iss || []).map(i => ({
    number: i.number, title: i.title,
    labels: (i.labels || []).map(l => l.name || l),
  }));
  return out;
}

// ---------------------------------------------------------------- 3. Host
function host() {
  const out = { disk: null, ram: null, processes: [], listeners: [], orphan_dirs: [] };

  // Explicit mount paths, because `df -h` wraps long filesystem names onto their own line and the
  // C: row was being dropped by the column check. Asking for the two paths avoids the wrapping.
  const df = run(['df', '-h', '/c', '/d'], 'host.df') || run(['df', '-h'], 'host.df');
  if (df) {
    const parse = (l) => { if (!l) return null; const c = l.trim().split(/\s+/); return { size: c[1], used: c[2], avail: c[3], use_pct: c[4], mount: c[c.length - 1] }; };
    const byMount = (re) => df.split('\n').map(s => s.trim()).find(l => {
      const c = l.split(/\s+/);
      return c.length >= 5 && re.test(c[c.length - 1]);
    }) || null;
    out.disk = { c: parse(byMount(/^(\/c|[Cc]:[\\/]?)$/)), d: parse(byMount(/^(\/d|[Dd]:[\\/]?)$/)) };
  }

  const os = run(['powershell', '-NoProfile', '-Command',
    "Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json"], 'host.ram');
  if (os) {
    const j = json(os, 'host.ram');
    if (j) out.ram = { total_mb: Math.round((j.TotalVisibleMemorySize || 0) / 1024), free_mb: Math.round((j.FreePhysicalMemory || 0) / 1024) };
  }

  const procs = run(['powershell', '-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,WorkingSetSize,CommandLine | ConvertTo-Json"], 'host.processes');
  if (procs) {
    const j = json(procs, 'host.processes');
    const arr = Array.isArray(j) ? j : (j ? [j] : []);
    out.processes = arr.map(p => ({
      pid: p.ProcessId, working_set_mb: Math.round((p.WorkingSetSize || 0) / 1048576),
      command_line: mask(String(p.CommandLine || '').slice(0, 300)),
    }));
  }

  const ns = run(['netstat', '-ano'], 'host.listeners');
  if (ns) {
    for (const l of ns.split('\n')) {
      const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(l);
      if (m && PORTS.includes(Number(m[1]))) out.listeners.push({ port: Number(m[1]), pid: Number(m[2]), state: 'LISTENING' });
    }
    out.listeners.sort((a, b) => a.port - b.port);
  }

  // Orphan directories: disk directories minus Orca's registered worktrees. A set difference, never a
  // heuristic, and the output is a LIST — nothing here deletes anything.
  const registered = new Set(ORCA_CACHE.worktrees.map(w => String(w.path).replace(/\\/g, '/').toLowerCase()));
  const dirs = run(['find', WORKSPACE_ROOT, '-maxdepth', '1', '-mindepth', '1', '-type', 'd'], 'host.find-worktrees');
  if (dirs) {
    const onDisk = dirs.split('\n').map(s => s.trim()).filter(Boolean);
    const orphans = onDisk.filter(d => !registered.has(d.replace(/\\/g, '/').toLowerCase()));

    // Sizes in ONE call, bounded. Per-directory `du` over a workspace full of node_modules is what
    // blew the first live run's budget; a timeout here degrades to "size unknown" and says so.
    const sizes = new Map();
    if (orphans.length) {
      const du = run(['du', '-sk', ...orphans], 'host.du', 60000, true);
      if (du) {
        for (const l of du.split('\n')) {
          const m = /^(\d+)\s+(.+)$/.exec(l.trim());
          if (m) sizes.set(m[2].replace(/\\/g, '/').toLowerCase(), Number(m[1]) * 1024);
        }
      } else {
        notes.push('orphan sizes unavailable (du timed out); paths are listed, sizes are 0');
      }
    }
    for (const d of orphans) {
      out.orphan_dirs.push({
        path: d.replace(/\\/g, '/'),
        size_bytes: sizes.get(d.replace(/\\/g, '/').toLowerCase()) || 0,
        registered: false,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 4. Derived
function derived(snap) {
  const byHandle = new Map(snap.orca.terminals.map(t => [t.handle, t]));
  // The table covers the OPEN tasks, not only the dispatched ones. A shadow run needs the fixer #93
  // shape — task ↔ terminal ↔ PR — and at the moment of a snapshot there may be nothing dispatched at
  // all, which would make an empty table look like a healthy pipeline. The status column carries the
  // truth instead.
  const TERMINAL_STATES = new Set(['completed', 'cancelled', 'archived']);
  const ORDER = { dispatched: 0, ready: 1, blocked: 2, failed: 3, todo: 4 };
  const open = snap.orca.tasks
    .filter(t => !TERMINAL_STATES.has(String(t.status)))
    .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
  const dispatched = new Map(snap.orca.dispatches.map(d => [d.task_id, d]));

  const table = open.map(t => {
    const d = dispatched.get(t.id) || null;
    const term = d ? byHandle.get(d.assignee_handle) || null : null;
    // A dispatch carries no branch, so the PR is matched by the number the task title names — which is
    // how these tasks are written ("fixer: rebase PR 93 onto the pipeline base"). No number in the
    // title means no PR link, recorded as null rather than guessed.
    const m = /\bPR\s*#?(\d+)\b|\b#(\d+)\b/i.exec(t.title || '');
    const num = m ? Number(m[1] || m[2]) : null;
    const pr = num ? snap.github.prs.find(p => p.number === num) || null : null;
    return {
      task_id: t.id,
      task_title: t.title || null,
      task_status: t.status,
      dispatched: !!d,
      assignee_handle: d ? d.assignee_handle : null,
      terminal: term ? { handle: term.handle, agent: term.agent, state: term.state } : null,
      liveness: d ? d.liveness : null,
      requires_action: d ? d.requires_action : null,
      pr: pr ? { number: pr.number, mergeable: pr.mergeable, verdict_comment: pr.verdict_comment, checks_state: pr.checks_state } : null,
    };
  });
  if (!snap.orca.dispatches.length) {
    notes.push(`no task is dispatched at this moment; the table lists the ${table.length} open task(s) with their status instead of being empty`);
  }
  return { task_terminal_pr_table: table, orphan_dirs: snap.host.orphan_dirs, notes };
}

// ---------------------------------------------------------------- main
const ORCA_CACHE = { worktrees: [] };

function main() {
  const snap = {
    schema: 'snapshot/1',
    taken_at_utc: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    taken_by: 'src/snapshot.js',
    read_only: true,
    errors: [],
    orca: null, github: null, host: null, derived: null,
  };

  snap.orca = orca();
  ORCA_CACHE.worktrees = snap.orca.worktrees;      // host needs it for the orphan set difference
  ORCA_CACHE.tasks = snap.orca.tasks;              // github needs it to decide which PRs to probe
  snap.github = github();
  snap.host = host();
  snap.derived = derived(snap);
  snap.errors = errors;

  // Mask the WHOLE document, not just the command lines. Masking one field meant a credential that
  // appeared anywhere else — a PR title, an issue body, a path — was written verbatim into a fixture.
  const text = mask(JSON.stringify(snap, null, 2));
  if (TO_STDOUT || FIXTURE) {
    process.stdout.write(text + '\n');
  } else {
    const dir = path.join(V2, 'state', 'snapshots');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${snap.taken_at_utc.replace(/[:]/g, '-')}.json`);
    fs.writeFileSync(file, text);
    console.log(`snapshot written: ${file} (${text.length} B)`);
    console.log(`tasks ${snap.orca.tasks.length} · dispatched ${snap.orca.dispatches.length} · terminals ${snap.orca.terminals.length} · prs ${snap.github.prs.length} · orphans ${snap.host.orphan_dirs.length} · errors ${snap.errors.length}`);
  }
  process.exit(snap.errors.length ? 1 : 0);
}

main();
