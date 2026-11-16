// spec.test.js — D2's contract: the four failure classes that actually cost the last session, plus
// the two blocks whose absence is invisible until a worker invents its own rules.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const V2 = 'D:/code/orca-supervisor';
const { lint, RESERVED_PORTS } = require(path.join(V2, 'src/spec-lint.js'));
const { fill } = require(path.join(V2, 'src/spec-gen.js'));

const GOOD = [
  'DISPATCH PARAMETERS — issue 121 · PR 130 · port 4222 · commit abc1234',
  '',
  'You are read-only. Do not edit, create, delete or commit any file. Do not run npm, vitest or tsc.',
  '',
  'INPUT: gh issue view 121 --json number,title,body ; gh pr diff 130 ; git show abc1234',
  '',
  'THE CLAIM: the rail keeps its frame during scroll.',
  '',
  'OBSERVABLE ACCEPTANCE — two steps. STEP 1 post the verdict as a PR comment carrying dsv-verdict.',
  '',
  'status: pass | fail',
  'scope_ok: yes | no',
].join('\n');

const rules = (text, opts) => lint(text, opts).errors.map(e => e.rule);

test('a good spec passes every rule', () => {
  const r = lint(GOOD, { issue: 121, pr: 130 });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.rules, 6);
});

test('FAILURE CLASS 1 — unfilled placeholder is rejected', () => {
  const bad = GOOD.replace('the rail keeps its frame during scroll.', '<what the PR says it does>');
  assert.ok(rules(bad, { issue: 121, pr: 130 }).includes('unfilled-placeholder'));
});

test('FAILURE CLASS 2 — a spec derived from another PR is rejected on its numbers', () => {
  // The real incident: a spec produced with sed from PR 122, dispatched for PR 123. The claims stayed
  // and the number changed in one place only, so the reviewer wrote its verdict on the wrong PR.
  const sed = GOOD.replace('PR 130', 'PR 130').replace('gh pr diff 130', 'gh pr diff 122')
    .replace('issue 121 --json', 'issue 112 --json');
  const found = rules(sed, { issue: 121, pr: 130 });
  assert.ok(found.includes('inconsistent-number'), `expected inconsistent-number, got ${found.join(',')}`);
});

test('FAILURE CLASS 3 — a port outside the reserved range is rejected', () => {
  // In range: 4173 and after, with a sanity cap (ORCHESTRATION.md says "4173 and after"; the pipeline
  // has used 4223, so an upper bound of 4221 would reject our own legitimate port).
  for (const p of ['4173', '4221', '4222', '4223']) {
    assert.strictEqual(lint(GOOD.replace('port 4222', `port ${p}`), { issue: 121, pr: 130 }).ok, true,
      `port ${p} is inside the reserved range and must pass`);
  }
  for (const p of ['8080', '3000', '4096', '5173']) {
    const found = rules(GOOD.replace('port 4222', `port ${p}`), { issue: 121, pr: 130 });
    assert.ok(found.includes('port-out-of-range'), `port ${p} must be rejected (reserved range is ${RESERVED_PORTS.min}-${RESERVED_PORTS.max})`);
  }
});

test('FAILURE CLASS 4 — a skipped verdict-comment step is rejected', () => {
  const noMarker = GOOD.replace('dsv-verdict', 'a verdict');
  assert.ok(rules(noMarker, { issue: 121, pr: 130 }).includes('missing-verdict-step'));

  // The marker present but never posted: this is the shape that produced "verdict yazılmadı" three times.
  const noPost = GOOD.replace('post the verdict as a PR comment carrying dsv-verdict',
    'produce a dsv-verdict block in your report');
  assert.ok(rules(noPost, { issue: 121, pr: 130 }).includes('missing-verdict-step'));
});

test('a missing forbidden-actions block is rejected', () => {
  const bad = GOOD.split('\n').filter(l => !/read-only|Do not/i.test(l)).join('\n');
  assert.ok(rules(bad, { issue: 121, pr: 130 }).includes('missing-forbidden-block'));
});

test('a missing acceptance block is rejected', () => {
  const bad = GOOD.replace('OBSERVABLE ACCEPTANCE — two steps. STEP 1 post the verdict as a PR comment carrying dsv-verdict.', '')
    .replace('status: pass | fail', '').replace('scope_ok: yes | no', '');
  assert.ok(rules(bad, { issue: 121, pr: 130 }).includes('missing-acceptance-block'));
});

test('spec-gen refuses to emit a template with placeholders left in it', () => {
  const tpl = fs.readFileSync(path.join(V2, 'templates/reviewer.md'), 'utf8');
  const partial = fill(tpl, { issue: 121, pr: 130, sets: {} });
  const r = lint(partial.text, { issue: 121, pr: 130 });
  assert.strictEqual(r.ok, false, 'a partially filled template must not pass');
  assert.ok(r.errors.some(e => e.rule === 'unfilled-placeholder'));
});

test('spec-gen fills a template and the result lints clean', () => {
  // The claim/trap prose placeholders are what a real dispatch fills; filling them is what makes the
  // difference between a spec that passes and one that is rejected for a leftover `<...>`.
  const tpl = fs.readFileSync(path.join(V2, 'templates/reviewer.md'), 'utf8');
  const placeholders = [...new Set([...tpl.matchAll(/<([^<>\n]{1,140})>/g)].map(m => m[1]))];
  const sets = {};
  for (const ph of placeholders) sets[ph] = 'filled by the test';
  const { text, used } = fill(tpl, { issue: 121, pr: 130, sha: 'abc1234', sets });
  assert.ok(used.length > 3, `expected several substitutions, got ${used.join(',')}`);
  const r = lint(text, { issue: 121, pr: 130 });
  assert.strictEqual(r.ok, true, `filled template must lint clean: ${JSON.stringify(r.errors)}`);
});

test('the copied templates are present and the pipeline originals were not touched', () => {
  for (const t of ['coder', 'fixer', 'reviewer', 'tester']) {
    assert.ok(fs.existsSync(path.join(V2, 'templates', `${t}.md`)), `templates/${t}.md must exist`);
  }
  // The originals live in the pipeline repo, which v2 never modifies; a copy that differs in size from
  // its original would mean someone edited one of them.
  const orig = 'C:/Users/user/orca/workspaces/design-system-viewer/proteus-5/docs/orchestration/specs';
  if (fs.existsSync(orig)) {
    for (const t of ['coder', 'fixer', 'reviewer', 'tester']) {
      const a = fs.statSync(path.join(V2, 'templates', `${t}.md`)).size;
      const b = fs.statSync(path.join(orig, `${t}.md`)).size;
      assert.strictEqual(a, b, `templates/${t}.md and its pipeline original differ in size`);
    }
  }
});
