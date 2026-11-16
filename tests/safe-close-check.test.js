// tests/safe-close-check.test.js -- the gate refuses on exactly the three real loss modes, and it
// does not touch the repository it inspects.
//
// Fixtures are built in a scratch directory with a bare "remote", so nothing here reads or writes
// any live worktree. The read-only assertion at the end is the point of the suite: a gate that
// silently refreshes an index or moves a ref while inspecting it is not stateless.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SCRIPT = path.join('D:/code/orca-supervisor', 'scripts', 'safe-close-check.sh');

function nat(p) {
  return p.replace(/\\/g, '/');
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', nat(cwd), ...args], { encoding: 'utf8' });
}

function run(wtPath) {
  const r = spawnSync('bash', [SCRIPT, nat(wtPath)], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-close-'));
  const remote = path.join(root, 'remote.git');
  const wt = path.join(root, 'worktree');
  fs.mkdirSync(remote);
  execFileSync('git', ['init', '--bare', '--quiet', nat(remote)]);
  execFileSync('git', ['clone', '--quiet', nat(remote), nat(wt)]);
  const id = ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t'];
  fs.writeFileSync(path.join(wt, 'a.txt'), 'one\n');
  git(wt, ...id, 'add', 'a.txt');
  git(wt, ...id, 'commit', '--quiet', '-m', 'first');
  git(wt, ...id, 'push', '--quiet', '-u', 'origin', 'HEAD');
  return { root, remote, wt, id };
}

function snapshot(wt) {
  return {
    status: git(wt, 'status', '--porcelain'),
    head: git(wt, 'rev-parse', 'HEAD'),
    reflog: git(wt, 'reflog', '--format=%H %gs').trim().split('\n').length,
  };
}

test('a clean, pushed worktree is safe to close', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const r = run(f.wt);
  assert.strictEqual(r.code, 0, `expected 0, got ${r.code}\n${r.out}`);
  assert.match(r.out, /SAFE/);
});

test('uncommitted work is refused, and named', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(f.wt, 'a.txt'), 'changed\n');
  const r = run(f.wt);
  assert.strictEqual(r.code, 1, `expected 1, got ${r.code}\n${r.out}`);
  assert.match(r.out, /uncommitted work: 1 entry/);
  assert.match(r.out, /a\.txt/);
});

test('.hermes-tmp.* scratch dirs are listed separately from real work', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(f.wt, '.hermes-tmp.ABC123'));
  fs.writeFileSync(path.join(f.wt, '.hermes-tmp.ABC123', 'blob'), 'x');
  fs.writeFileSync(path.join(f.wt, 'real.txt'), 'work\n');
  const r = run(f.wt);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /uncommitted work: 1 entry/);
  assert.match(r.out, /1 \.hermes-tmp\.\* scratch dir/);
});

test('scratch-only status still refuses, but says so separately', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  // A file inside it: git does not report an empty directory, so the scratch dir must have
  // something in it to appear in status at all.
  fs.mkdirSync(path.join(f.wt, '.hermes-tmp.ONLY1'));
  fs.writeFileSync(path.join(f.wt, '.hermes-tmp.ONLY1', 'blob'), 'x');
  const r = run(f.wt);
  assert.strictEqual(r.code, 1, `expected 1, got ${r.code}\n${r.out}`);
  assert.match(r.out, /scratch dir\(s\) only/);
});

test('a commit that exists nowhere else is refused, with its sha', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(f.wt, 'b.txt'), 'two\n');
  git(f.wt, ...f.id, 'add', 'b.txt');
  git(f.wt, ...f.id, 'commit', '--quiet', '-m', 'local only');
  const sha = git(f.wt, 'rev-parse', '--short', 'HEAD').trim();
  const r = run(f.wt);
  assert.strictEqual(r.code, 1, `expected 1, got ${r.code}\n${r.out}`);
  assert.match(r.out, /not reachable from any remote-tracking branch/);
  assert.ok(r.out.includes(sha), `expected ${sha} in output:\n${r.out}`);
});

test('a branch with no upstream is refused', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  git(f.wt, 'checkout', '--quiet', '-b', 'orphan-branch');
  const r = run(f.wt);
  assert.strictEqual(r.code, 1, `expected 1, got ${r.code}\n${r.out}`);
  assert.match(r.out, /no upstream configured for branch/);
});

test('a detached HEAD is refused', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  git(f.wt, 'checkout', '--quiet', '--detach', 'HEAD');
  const r = run(f.wt);
  assert.strictEqual(r.code, 1, `expected 1, got ${r.code}\n${r.out}`);
  assert.match(r.out, /detached HEAD/);
});

test('a path that is not a working tree is a usage error, not a verdict', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-close-bad-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = run(root);
  assert.strictEqual(r.code, 2, `expected 2, got ${r.code}\n${r.out}`);
  assert.match(r.out, /not a git working tree/);
});

test('no argument is a usage error', () => {
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  assert.match(r.stdout, /usage:/);
});

test('the gate is read-only: status, HEAD and reflog are untouched by a run', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(f.wt, 'dirty.txt'), 'dirty\n');
  const before = snapshot(f.wt);
  const r = run(f.wt);
  const after = snapshot(f.wt);
  assert.strictEqual(r.code, 1, 'the fixture is dirty, so the gate must refuse');
  assert.deepStrictEqual(after, before, 'the gate changed the repository it inspected');
});
