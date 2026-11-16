#!/usr/bin/env node
// guard-exec.test.js — parametric contract test for src/guard/exec.js (TASKS.md section 3).
//
// Every allowed command must pass; EVERY command on the forbidden list must be rejected. The
// decision function is what is tested: no real command is executed here, and the one run() call
// is made in dry-run mode on purpose to prove the gate refuses to spawn without a real request.
//
//   node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { decide, run, DENY, flags } = require('../src/guard/exec.js');

const LOG = 'D:/code/orca-supervisor/logs/exec.log';

// ---- section 3: ALLOWED ---------------------------------------------------------------------
const ALLOWED = [
  'orca --version',
  'orca status',
  'orca terminal list --json',
  'orca terminal read --terminal term_abc --screen',
  'orca terminal show --terminal term_abc --json',
  'orca orchestration task-list --json',
  'orca orchestration worker-list --run run_4e539259ab29 --json',
  'orca orchestration dispatch-show --task task_c23d87eea0c9 --json',
  'orca orchestration worker-show --dispatch ctx_847b51e6fd84 --json',
  'orca worktree list --json',
  'orca worktree ps',
  'orca skills get orchestration',
  'orca repo show --repo design-system-viewer',
  'gh pr list --state open --json number',
  'gh pr view 93 --json headRefOid',
  'gh pr checks 93',
  'gh issue list --state open',
  'gh issue view 88 --json number,title',
  'gh api repos/ernem22/design-system-viewer/branches/refactor%2Ffull-react-migration/protection',
  'gh api repos/x/y -X GET',
  'git log --oneline -5',
  'git status --porcelain',
  'git diff --stat',
  'git rev-parse HEAD',
  'git ls-files',
  'git worktree list',
  'git -C D:/code/design-system-viewer rev-parse HEAD',
  'git -C C:/Users/user/orca/workspaces/design-system-viewer/proteus-5 status --porcelain',
  'git -C D:/code/design-system-viewer branch -r --format=%(refname:short)',
  'ls -la',
  'find . -type f',
  'df -h',
  'ps -ef',
  'netstat -ano',
  'node --test tests/*.test.js',
];

// ---- section 3 + hardening: FORBIDDEN -------------------------------------------------------
const FORBIDDEN = [
  // inline node and npm writes are denied by the hardening pass
  'node -e "console.log(1)"',
  'node -p "1+1"',
  'node --eval "x"',
  'node --print "x"',
  'npm install',
  'npm ci',
  'npm run test',
  'npm --prefix app run test',
  'npm exec -- x',
  'npm update',
  'npm uninstall x',
  'npm publish',
  'npm link',
  'npm audit fix',
  // orca orchestration mutations
  'orca orchestration send --run run_4e539259ab29 --to dispatch:ctx_x --body hi',
  'orca orchestration ack delivery_x',
  'orca orchestration check --run run_4e539259ab29 --json',
  'orca orchestration check --run run_4e539259ab29 --wait --timeout-ms 30000',
  'orca orchestration worker-start --spec x --terminal term_a',
  'orca orchestration worker-stop --dispatch ctx_x',
  'orca orchestration worker-release --dispatch ctx_x',
  'orca orchestration worker-abandon --dispatch ctx_x',
  'orca orchestration run-create',
  'orca orchestration run-use --id run_x',
  'orca orchestration dispatch --task task_x --terminal term_a',
  'orca orchestration task-create --title x',
  'orca orchestration task-update --id task_x --status completed',
  'orca orchestration gate-resolve --id g1',
  'orca orchestration gate-create --id g1',
  // orca terminal mutations
  'orca terminal create --worktree id:x --command opencode',
  'orca terminal send --terminal term_a --text hi',
  'orca terminal close --terminal term_a',
  'orca terminal stop --terminal term_a',
  // orca worktree mutations
  'orca worktree create --name x',
  'orca worktree rm --worktree id:x --force',
  'orca worktree set --worktree id:x',
  // gh writes
  'gh pr edit 93 --body x',
  'gh pr close 93',
  'gh pr merge 93 --squash',
  'gh pr comment 93 --body x',
  'gh pr create --title x',
  'gh issue close 88',
  'gh issue comment 88 --body x',
  'gh issue create --title x',
  'gh label create foo',
  'gh api repos/x/y -X POST',
  'gh api repos/x/y --method PATCH',
  'gh api repos/x/y -X DELETE',
  // git writes
  'git commit -m x',
  'git push origin HEAD:main',
  'git push origin HEAD --force',
  'git checkout main',
  'git switch main',
  'git reset --hard HEAD~1',
  'git clean -fd',
  'git merge origin/main',
  'git rebase origin/main',
  'git cherry-pick abc123',
  'git stash',
  'git branch -D old',
  'git worktree add D:/tmp/x main',
  'git worktree remove D:/tmp/x',
  'git worktree prune',
  'git -C D:/code/design-system-viewer push origin HEAD:main',
  'git -C D:/code/design-system-viewer reset --hard HEAD~1',
  'git -C D:/code/design-system-viewer worktree remove D:/tmp/x',
  'git -C D:/code/design-system-viewer branch -D old',
  // OS writes
  'taskkill -F -PID 1234',
  'Stop-Process -Id 1234 -Force',
  'rm -rf D:/code/something',
  'del /f x.txt',
  'Remove-Item -Recurse D:/x',
  'schtasks /create /tn sup-shadow',
  'powershell -NoProfile -Command "Stop-Process -Id 5 -Force"',
  'powershell -NoProfile -Command "Remove-Item -Recurse D:/x"',
  'powershell -NoProfile -Command "Set-Content D:/x 1"',
];

test('every ALLOWED command passes the gate', () => {
  for (const cmd of ALLOWED) {
    const d = decide(cmd);
    assert.strictEqual(d.allow, true, `expected ALLOW for: ${cmd} (got ${d.rule}: ${d.reason})`);
  }
});

test('EVERY FORBIDDEN command is rejected', () => {
  for (const cmd of FORBIDDEN) {
    const d = decide(cmd);
    assert.strictEqual(d.allow, false, `expected DENY for: ${cmd} (got ${d.rule})`);
  }
});

test('every DENY rule is exercised by at least one forbidden case', () => {
  const hit = new Set();
  for (const cmd of FORBIDDEN) {
    for (const r of DENY) if (r.re.test(cmd)) hit.add(r.re.source);
  }
  const unexercised = DENY.map(r => r.re.source).filter(s => !hit.has(s));
  assert.deepStrictEqual(unexercised, [], `DENY rules with no test case: ${unexercised.join(' | ')}`);
});

test('unknown commands default to deny', () => {
  for (const cmd of ['curl https://example.com', 'python -c "print(1)"', 'kubectl get pods', '']) {
    assert.strictEqual(decide(cmd).allow, false, `expected default DENY for: ${cmd}`);
  }
});

test('check --all is denied until A2 clears it, and allowed only after', () => {
  const cmd = 'orca orchestration check --run run_4e539259ab29 --all --json';
  assert.strictEqual(flags.allowCheckAll, false, 'A2 has not run yet: the flag must still be false');
  assert.strictEqual(decide(cmd).allow, false);
  flags.allowCheckAll = true;
  const after = decide(cmd);
  assert.strictEqual(after.allow, true);
  assert.strictEqual(after.rule, 'allow:check-all');
  flags.allowCheckAll = false; // leave the world as we found it
});

test('run() in dry-run mode logs the decision and spawns nothing', () => {
  const before = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length : 0;
  const r = run(['orca', '--version'], { dryRun: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(r.stdout, undefined, 'dry run must not produce command output');
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, before + 1, 'exactly one log line must be appended');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(last.executed, false, 'dry run must record executed:false');
  assert.strictEqual(last.decision, 'allow');
  assert.strictEqual(last.command, 'orca --version');
});

test('run() on a forbidden command is denied, logged, and spawns nothing', () => {
  const before = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length;
  const r = run(['git', 'push', 'origin', 'HEAD:main'], { dryRun: false });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.decision.allow, false);
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, before + 1);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(last.decision, 'deny');
  assert.strictEqual(last.executed, false);
});
