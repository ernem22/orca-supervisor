// set-job-scope.js — lock the sup-lessons-review job's own write scope.
//
// The CLI's `cron create` has no toolset flag, but `enabled_toolsets` is a real job field the
// scheduler reads. Setting it to a set that contains NO local write tools (no file, no terminal,
// no code_execution, no skills) means the job cannot write anything, anywhere, by construction —
// which is the "enforced by the job's own scope" requirement, rather than a prompt that asks nicely.
//
// The proposal file is still produced: the job's pre-step script writes it, and the script's stdout
// (the proposal itself) is injected into the prompt. The agent's contribution is judgement.
const fs = require('fs');
const p = process.env.J;
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const job = (j.jobs || []).find(x => x.name === 'sup-lessons-review');
if (!job) { console.log('job not found'); process.exit(1); }
job.enabled_toolsets = ['web'];
fs.writeFileSync(p, JSON.stringify(j, null, 2));
console.log('job', job.id, 'enabled_toolsets =', JSON.stringify(job.enabled_toolsets));
console.log('still paused:', job.enabled === false, '| paused_reason:', (job.paused_reason || '').slice(0, 50));
