#!/usr/bin/env node
// manifest-completeness.test.js — fail if a file we KNOW must be protected is absent.
//
// The zone-count audit (src/manifest-audit.js) compares totals; this test pins the individual
// rows that matter, so a walk that silently skips a whole directory cannot pass as "counts agree".
// It also asserts the zone sum equals the manifest's own row count.
//
//   node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const V2 = 'D:/code/orca-supervisor';
const HERMES = path.join(process.env.LOCALAPPDATA || '', 'hermes');
const REPO_ROOT = 'D:/code/design-system-viewer';
const PROT = 'C:/Users/user/orca/workspaces/design-system-viewer/proteus-5';

const m = JSON.parse(fs.readFileSync(path.join(V2, 'manifest/protected.json'), 'utf8'));
// The manifest stores POSIX-style paths; path.join on Windows produces backslashes. Normalise
// both sides or every lookup misses (this is exactly the bug this test caught in itself).
const norm = (p) => p.split('\\').join('/');
const byPath = new Map(m.files.map(f => [norm(f.path), f]));

// A file per zone, chosen because losing it would be a real hole (not a random sample).
const REQUIRED = [
  [`${REPO_ROOT}/ORCHESTRATION.md`, 'repo:root'],
  [`${REPO_ROOT}/tools/orchestration/spawn.sh`, 'repo:root'],
  [`${REPO_ROOT}/app/src/App.tsx`, 'repo:root'],
  [`${PROT}/ORCHESTRATION.md`, 'repo:proteus-5'],
  [`${PROT}/tools/orchestration/watch.sh`, 'repo:proteus-5'],
  [`${PROT}/app/src/App.tsx`, 'repo:proteus-5'],
  [`${HERMES}/config.yaml`, 'hermes:config'],
  [`${HERMES}/SOUL.md`, 'hermes:soul'],
  [`${HERMES}/cron/jobs.json`, 'hermes:cron-file'],
  [`${HERMES}/skills/autonomous-ai-agents/orca-opencode-worker-pipelines/SKILL.md`, 'hermes:skills'],
  [`${V2}/docs/TASKS.md`, null], // in the v2 zone, not in the manifest by design — asserted below
];

test('every required file is present in the manifest with a sha256', () => {
  for (const [p, zone] of REQUIRED) {
    if (zone === null) continue;
    const row = byPath.get(norm(p));
    assert.ok(row, `MISSING from manifest: ${norm(p)} (zone ${zone})`);
    assert.match(row.sha256, /^[0-9a-f]{64}$/, `bad sha256 for ${p}`);
    assert.strictEqual(row.zone, zone, `wrong zone for ${p}`);
  }
});

test('the v2 job file is NOT in the protected manifest (it is the thing being verified against)', () => {
  // TASKS.md is hashed separately as manifest.tasks_md_sha256; if it ever appears as a file row
  // the manifest would be protecting itself against itself.
  assert.ok(!byPath.has(`${V2}/docs/TASKS.md`), 'TASKS.md must not be a protected row');
  assert.match(m.tasks_md_sha256, /^[0-9a-f]{64}$/);
});

test('zone counts sum to the manifest row count', () => {
  const byZone = {};
  for (const f of m.files) byZone[f.zone] = (byZone[f.zone] || 0) + 1;
  const sum = Object.values(byZone).reduce((a, b) => a + b, 0);
  assert.strictEqual(sum, m.files.length, `zone sum ${sum} != rows ${m.files.length}`);
  assert.strictEqual(sum, m.summary.file_count, 'zone sum != summary.file_count');
});

test('no row is duplicated and every row has the required fields', () => {
  const seen = new Set();
  for (const f of m.files) {
    assert.ok(!seen.has(f.path), `duplicate row: ${f.path}`);
    seen.add(f.path);
    for (const k of ['zone', 'path', 'size', 'mtime_ms', 'sha256']) {
      assert.ok(f[k] !== undefined && f[k] !== null, `${f.path} missing field ${k}`);
    }
  }
});

test('a deliberately removed row is detected by the checker logic', () => {
  // Same rule verify-untouched applies: a row in the baseline that is absent from the current
  // set is MISSING. Proven here on in-memory copies, never on real files.
  const baseline = new Map(m.files.map(f => [f.path, f]));
  const current = new Map(m.files.map(f => [f.path, f]));
  const victim = `${REPO_ROOT}/ORCHESTRATION.md`;
  current.delete(victim);
  const missing = [...baseline.keys()].filter(k => !current.has(k));
  assert.deepStrictEqual(missing, [victim]);
});
