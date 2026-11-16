#!/usr/bin/env node
// cron-def-drift.js — read-only. Which cron definition field changed?
// The verifier reports "definition changed" but not which field; the definition/runtime split is
// only as good as its field list, so this names the field.
const fs = require('fs');
const path = require('path');

const H = path.join(process.env.LOCALAPPDATA || '', 'hermes');
const jobs = (JSON.parse(fs.readFileSync(path.join(H, 'cron/jobs.json'), 'utf8')).jobs) || [];
const manifest = JSON.parse(fs.readFileSync('D:/code/orca-supervisor/manifest/protected.json', 'utf8'));
const defFields = (manifest.dynamic.cron_fields || {}).definition || [];
const rtFields = (manifest.dynamic.cron_fields || {}).runtime || [];

const sha = (v) => require('crypto').createHash('sha256').update(JSON.stringify(v)).digest('hex');
const pick = (o, keys) => { const r = {}; for (const k of keys) if (k in o) r[k] = o[k]; return r; };

for (const j of jobs) {
  console.log(`job ${j.name} (${j.id})`);
  // mirror build-manifest's hybrid handling: repeat.times is definition, repeat.completed runtime
  const defProj = (o) => { const r = pick(o, defFields); if (o.repeat && typeof o.repeat === 'object') r.repeat_times = o.repeat.times ?? null; return r; };
  const now = sha(defProj(j));
  const stored = ((manifest.dynamic.cron_jobs || [])[0] || {}).definition_sha256;
  console.log(`  definition_sha256 now=${now.slice(0, 16)} stored=${String(stored).slice(0, 16)} ${now === stored ? 'MATCH' : 'DIFFERS'}`);
  if (now !== stored) {
    console.log('  definition fields present now:');
    for (const k of defFields) if (k in j) console.log(`    ${k} = ${JSON.stringify(j[k]).slice(0, 140)}`);
    console.log('  runtime fields present now (these are allowed to change):');
    for (const k of rtFields) if (k in j) console.log(`    ${k} = ${JSON.stringify(j[k]).slice(0, 90)}`);
    const unclassified = Object.keys(j).filter(k => !defFields.includes(k) && !rtFields.includes(k));
    console.log(`  fields in NEITHER list (a gap in the split): ${unclassified.join(', ') || 'none'}`);
  }
}
