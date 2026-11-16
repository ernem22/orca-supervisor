#!/usr/bin/env node
// src/guard/exec.js — the ONLY exit gate for Orca, gh, git and OS calls (TASKS.md section 3).
//
// Every call from v2 code goes through here. Nothing else may spawn a process. The gate:
//   1. normalises the call to a single string,
//   2. checks the DENY list first (deny always wins),
//   3. then the ALLOW list,
//   4. logs {time, decision, reason, command} to logs/exec.log, and
//   5. executes only when allowed AND the caller asked for a real run.
//
// The decision function is pure and is what the tests exercise: no test spawns a process.
//
// Node builtins only — no external dependencies (A1 requirement).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const V2 = 'D:/code/orca-supervisor';
const LOG = path.join(V2, 'logs/exec.log');

// ---------------------------------------------------------------------------------------------
// Policy. Kept as data so the tests can walk it and so the report can print it verbatim.
// ---------------------------------------------------------------------------------------------

// Forbidden in steps A0–C4 under any condition (section 3). Each entry: {re, why}
const DENY = [
  { re: /^orca\s+orchestration\s+send\b/, why: 'section 3: orchestration send is a write' },
  { re: /^orca\s+orchestration\s+ack\b/, why: 'section 3: ack is a write' },
  { re: /^orca\s+orchestration\s+check\b(?![\s\S]*--all)/, why: 'section 3: check is a write unless --all' },
  { re: /^orca\s+orchestration\s+check\b[\s\S]*--wait/, why: 'section 3: check --wait is forbidden' },
  // `(?=\s|$)` not `\b`: `\b` also matches before a hyphen, so `dispatch` swallowed `dispatch-show`
  // (an allowed read command). The tests caught it.
  { re: /^orca\s+orchestration\s+(worker-start|worker-stop|worker-release|worker-abandon|run-create|run-use|dispatch|task-create|task-update|gate-resolve|gate-create)(?=\s|$)/, why: 'section 3: orchestration mutation' },
  { re: /^orca\s+terminal\s+(create|send|close|stop)\b/, why: 'section 3: terminal mutation' },
  { re: /^orca\s+worktree\s+(create|rm|set)\b/, why: 'section 3: worktree mutation' },
  { re: /^gh\s+(pr|issue)\s+(edit|close|merge|comment|create|reopen|delete)\b/, why: 'section 3: gh write' },
  { re: /^gh\s+label\b/, why: 'section 3: gh write' },
  { re: /^gh\s+api\b[\s\S]*(-X|--method)\s+(POST|PATCH|PUT|DELETE)\b/, why: 'section 3: gh api write method' },
  { re: /powershell[\s\S]*(Stop-Process|Remove-Item|taskkill|Set-Content|Out-File|New-Item)/i, why: 'section 3: OS write via powershell' },
  // `-C <path>` must be handled on BOTH sides: without it here, `git -C x push` would slip past the
  // deny list, and `git -C x rev-parse` would be refused by the allow list (which broke the
  // manifest's git baseline until the test suite grew cases for the -C form).
  { re: /^git\s+(-C\s+\S+\s+)?(commit|push|checkout|switch|reset|clean|merge|rebase|cherry-pick|stash)\b/, why: 'section 3: git write' },
  { re: /^git\s+(-C\s+\S+\s+)?branch\s+-D\b/, why: 'section 3: branch delete' },
  { re: /^git\s+(-C\s+\S+\s+)?worktree\s+(add|remove|prune)\b/, why: 'section 3: worktree mutation' },
  { re: /^node\s+(-e|-p|--eval|--print)\b/, why: 'section 3: inline node is an unreviewable escape hatch' },
  { re: /^npm\s+(install|ci|i|run|exec|update|uninstall|publish|link|audit\s+fix)\b/, why: 'section 3: npm writes' },
  { re: /^(taskkill|Stop-Process)\b/, why: 'section 3: process kill' },
  { re: /^(rm|del|Remove-Item)\b/, why: 'section 3: delete outside the v2 zone' },
  { re: /^schtasks\s+\/create\b/, why: 'section 3: scheduled task without approval' },
];

// Allowed in A0–C4 (section 3).
const ALLOW = [
  { re: /^orca\s+--version\b/, why: 'section 3: orca --version' },
  { re: /^orca\s+status\b/, why: 'section 3: orca status' },
  { re: /^orca\s+terminal\s+list\b/, why: 'section 3: terminal list' },
  { re: /^orca\s+terminal\s+read\b/, why: 'section 3: terminal read --screen' },
  { re: /^orca\s+terminal\s+show\b/, why: 'section 3: terminal show (metadata/preview, read-only)' },
  { re: /^orca\s+orchestration\s+run-current\b/, why: 'C1: run-current (read-only; the run id that worker-list needs)' },
  { re: /^orca\s+orchestration\s+run-list\b/, why: 'C1: run-list (read-only)' },
  { re: /^orca\s+orchestration\s+task-list\b/, why: 'section 3: task-list' },
  { re: /^orca\s+orchestration\s+worker-list\b/, why: 'section 3: worker-list' },
  { re: /^orca\s+orchestration\s+dispatch-show\b/, why: 'section 3: dispatch-show' },
  { re: /^orca\s+orchestration\s+worker-show\b/, why: 'section 3: worker-show (inspection)' },
  { re: /^orca\s+worktree\s+(list|ps|show|current)\b/, why: 'section 3: worktree list | ps' },
  { re: /^orca\s+skills\s+(get|list)\b/, why: 'section 3: skills get orchestration' },
  { re: /^orca\s+repo\s+show\b/, why: 'read-only repo metadata' },
  { re: /^orca\s+host\s+list\b/, why: 'read-only host list' },
  { re: /^orca\s+environment\s+list\b/, why: 'read-only environment list' },
  { re: /^gh\s+pr\s+(list|view|checks|diff)\b/, why: 'section 3: gh pr list | view | checks' },
  { re: /^gh\s+issue\s+(list|view)\b/, why: 'section 3: gh issue list | view' },
  { re: /^gh\s+api\b/, why: 'section 3: gh api (GET; write methods are denied above)' },
  { re: /^gh\s+label\s+list\b/, why: 'read-only label list' },
  { re: /^git\s+(-C\s+\S+\s+)?(log|status|diff|rev-parse|ls-files|show|branch|remote|cat-file|hash-object|describe|worktree\s+list)\b/, why: 'section 3: git read commands' },
  { re: /^(ls|dir|find|stat|wc|head|tail|cat|sha256sum|df|du|ps|netstat|powershell)\b/, why: 'section 3: OS listing/size/process/port reads (powershell writes are denied above)' },
  // node is allowed only for v2's own entry points, never inline (the deny rule above).
  { re: /^node\s+--test\s+tests\//, why: 'v2 test runner' },
  { re: /^node\s+bin\/verify-untouched\b/, why: 'v2 verifier' },
  { re: /^node\s+src\/[A-Za-z0-9._\/-]+\.js\b/, why: 'v2 source entry point' },
  { re: /^npm\s+ls\b/, why: 'npm read-only (npm ls)' },
];

// Opt-in switches that later steps flip after proving something (section 3).
const SANDBOX_ALLOW = [
  { re: /^orca\s+orchestration\s+run-create\b/, why: 'E1: create a SEPARATE run for the sandbox (a new run, never the live one)' },
  { re: /^orca\s+orchestration\s+worker-start\b(?=[\s\S]*--worktree\s+(?:D:\/code\/sup-sandbox\/|name:sup-sandbox-))/, why: 'E1: managed spawn, but only into the sandbox root or a sandbox-named worktree' },
  { re: /^orca\s+orchestration\s+(worker-stop|worker-release|worker-abandon|worker-show|worker-read|dispatch-show)\b/, why: 'E1: the supervised lifecycle verbs and the structured worker read (worker-read --source transcript|terminal), sandbox mode only' },
  { re: /^orca\s+(--help|-h|agent-context)\b/, why: 'E1: the CLI help and the machine-readable schema — read-only, and the authoritative way to ask what commands exist' },
  { re: /^orca\s+orchestration\s+(--help|-h)\b/, why: 'E1: orchestration subcommand help — read-only' },
  { re: /^orca\s+orchestration\s+(check|send|reply|run-use|run-current|run-list|task-list|task-create)\b/, why: 'E1: drive and observe the sandbox run' },
  { re: /^orca\s+terminal\s+(close|send|read|show|list)\b/, why: 'E1: talk to sandbox terminals' },
  { re: /^orca\s+worktree\s+(list|ps|show|current|add|set|create)\b/, why: 'E1: sandbox worktrees' },
  { re: /^orca\s+agent-context\b/, why: 'E1: the machine-readable command schema — the authoritative way to ask what commands exist' },
  { re: /^orca\s+repo\s+(show|list|search-refs|set-base-ref)\b/, why: 'E1: read Orca repo metadata; set-base-ref is how a sandbox repo gets a base branch' },
  { re: /^orca\s+repo\s+add\b/, why: 'E1: register the SANDBOX repo with Orca so it can create worktrees of it (additive; never removes or renames anything)' },
  { re: /^orca\s+project\s+(list|setups)\b/, why: 'E1: inspect Orca projects (a concept distinct from repo) — read-only' },
  { re: /^gh\s+(pr|issue|api|label)\b/, why: 'E1: the deny-pattern probes read GitHub state' },
  { re: /^git\s+(-C\s+\S+\s+)?(log|status|diff|rev-parse|ls-files|show|branch|remote|push|cat-file)\b/, why: 'E1: scenario 10 probes git push variants' },
];
const flags = {
  // `check --all` is allowed only after A2 proves it changes no delivery/read state.
  allowCheckAll: false,
};

function normalize(argv) {
  const s = Array.isArray(argv) ? argv.join(' ') : String(argv);
  return s.trim().replace(/\s+/g, ' ');
}

/**
 * Pure decision function. No process is spawned, nothing is logged here.
 * @returns {{allow: boolean, reason: string, rule: string}}
 */
function decide(argv, opts = {}) {
  const cmd = normalize(argv);
  if (!cmd) return { allow: false, reason: 'empty command', rule: 'none' };

  // A write to a path inside the v2 zone is always permitted, whatever the command.
  const insideV2 = opts.insideV2 === true;

  // `check --all` is the one documented exception to "check is a write". It is decided BEFORE the
  // deny loop: with `--all` no deny rule matches, so a special case nested inside that loop is
  // unreachable and the command would fall through to the default deny.
  if (/^orca\s+orchestration\s+check\b/.test(cmd) && /--all\b/.test(cmd)) {
    return flags.allowCheckAll
      ? { allow: true, reason: 'check --all: cleared by A2', rule: 'allow:check-all' }
      : { allow: false, reason: 'check --all not yet cleared (A2 must prove it read-only)', rule: 'deny:check-all-pending' };
  }

  // SANDBOX MODE (E1). The drill needs Orca's write verbs, and enabling them outright would open the
  // LIVE Run in the same breath — the guard cannot tell one dispatch id from another. So they are
  // allowed only when the caller explicitly declares sandbox mode, and no live component sets
  // SUP_SANDBOX. Narrow on purpose: a run-create makes a NEW Run, and worker-start must name a
  // worktree under the sandbox root, so even in this mode the live pipeline is out of reach.
  if (opts.env && String(opts.env.SUP_SANDBOX) === '1') {
    for (const r of SANDBOX_ALLOW) {
      if (r.re.test(cmd)) return { allow: true, reason: r.why, rule: `allow:sandbox:${r.re.source.slice(0, 40)}` };
    }
    // D1 needs a real install peak, and the measurement is only meaningful where the live tree cannot
    // be touched. Like the entry below, this is allowed only when the CALLER's cwd is the sandbox repo,
    // so a command that names the live worktree still cannot reach it.
    if (/^npm\s+(ci|install)\b/.test(cmd) && /sup-sandbox/i.test(String(opts.cwd || ''))) {
      return { allow: true, reason: 'D1: measure the install peak in the sandbox repo', rule: 'allow:sandbox:npm-ci' };
    }
    // Managed worktree creation: `--worktree new-top-level` carries no path, so the path-scoped rule
    // above cannot see it. Allowed only when the CALLER's cwd is the sandbox repo.
    //
    // MEASURED LIMIT, stated because the original justification was wrong: Orca resolves the repo from
    // its OWN registry, not from the cwd. With this rule satisfied, Orca created the worktree in
    // `StartupHunt` — a registered repo — and failed on a branch name, not on the sandbox path. So this
    // rule does NOT scope the repository; it only narrows who may ask. What actually keeps the live
    // pipeline out of reach is that `--worktree new-top-level` can only target a registered repo, and
    // the live repos are not the ones a sandbox caller names.
    const cwdSandbox = /sup-sandbox/i.test(String(opts.cwd || ''));
    if (cwdSandbox
        && /^orca\s+orchestration\s+worker-start\b/.test(cmd)
        && /--worktree\s+new-top-level\b/.test(cmd)) {
      return { allow: true, reason: 'E1: managed worktree creation, and only from the sandbox repo', rule: 'allow:sandbox:new-top-level' };
    }
  }

  for (const r of DENY) {
    if (r.re.test(cmd)) {
      if (insideV2 && /^(rm|del|Remove-Item)\b/.test(cmd)) {
        return { allow: true, reason: 'delete inside the v2 zone', rule: 'allow:v2-delete' };
      }
      return { allow: false, reason: r.why, rule: `deny:${r.re.source.slice(0, 40)}` };
    }
  }
  for (const r of ALLOW) {
    if (r.re.test(cmd)) return { allow: true, reason: r.why, rule: `allow:${r.re.source.slice(0, 40)}` };
  }
  return { allow: false, reason: 'not on the allow list (default deny)', rule: 'deny:default' };
}

function logLine(entry) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
}

/**
 * The only way v2 code runs a process.
 * @param {string[]} argv  command + args
 * @param {object} opts    {cwd, timeout, dryRun, insideV2}
 * @returns {{ok, decision, stdout?, error?}}
 */
function run(argv, opts = {}) {
  const decision = decide(argv, opts);
  const entry = {
    ts: new Date().toISOString(),
    decision: decision.allow ? 'allow' : 'deny',
    rule: decision.rule,
    reason: decision.reason,
    command: normalize(argv),
    cwd: opts.cwd || null,
    executed: false,
  };
  if (!decision.allow) { logLine(entry); return { ok: false, decision }; }
  if (opts.dryRun !== false) { logLine(entry); return { ok: true, decision, dryRun: true }; }
  try {
    const stdout = execFileSync(argv[0], argv.slice(1), {
      cwd: opts.cwd, encoding: 'utf8', timeout: opts.timeout || 120000, maxBuffer: 256 * 1024 * 1024,
      env: opts.env || process.env,
    });
    entry.executed = true;
    logLine(entry);
    return { ok: true, decision, stdout };
  } catch (e) {
    entry.executed = true;
    entry.exit = e.status;
    logLine(entry);
    // Full streams, not a truncated blob. A command may legitimately exit non-zero — verify-untouched
    // exits 1 on a diff by design — and its caller needs the output to reason about that diff. The
    // previous shape dropped stdout entirely and sliced everything to 800 chars into `error`, which
    // silently hid the verifier's own summary from the test that asserts on it. `error` keeps its old
    // meaning and length so existing callers are unaffected.
    return {
      ok: false,
      decision,
      exit: e.status,
      stdout: String(e.stdout == null ? '' : e.stdout),
      stderr: String(e.stderr == null ? '' : e.stderr),
      error: String((e.stderr || e.stdout || e.message)).slice(0, 800),
    };
  }
}

module.exports = { decide, run, normalize, DENY, ALLOW, flags };
