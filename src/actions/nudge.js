#!/usr/bin/env node
// src/actions/nudge.js — ask a worker for the report it never sent. Not destructive.
//
// A nudge changes nothing about the worker's process; it puts a message in front of it. It is
// therefore the only action in this set that may be proposed on weaker evidence, and even then it
// needs a live terminal to deliver to.
const { makeExecutor } = require('./_core.js');

const executor = makeExecutor({
  name: 'nudge',

  preconditions(spec) {
    const missing = [];
    if (!spec.dispatch_id) missing.push('no dispatch_id to nudge');
    if (!spec.assignee_handle) missing.push('no assignee handle: there is no terminal to deliver to');
    if (spec.terminal_exists === false) missing.push('the terminal no longer exists');
    return missing;
  },

  // Idempotent in the sense that matters: if the dispatch is already gone or already exited, there is
  // nothing left to nudge, and re-sending would be noise in a worker's context.
  alreadyDone(spec) {
    return spec.liveness === 'exited' || spec.task_status === 'completed' || spec.task_status === 'cancelled';
  },

  classify(spec) {
    return spec.resource_state && spec.resource_state !== 'external' ? 'supervised' : 'external';
  },

  argv(spec) {
    // run_id is REQUIRED. An earlier version fell back to the live run's id, so a sandbox nudge with no
    // run_id produced a command addressed to `run_4e539259ab29` — the live pipeline. A dry run showed it
    // and nothing was sent, but the fallback was one --apply away from messaging a live worker.
    if (!spec.run_id) throw new Error('nudge: run_id is required — refusing to fall back to a run id, and never to the live one');
    if (!spec.coordinator_handle) throw new Error('nudge: coordinator_handle is required');
    return [
      'orca', 'orchestration', 'send',
      '--run', spec.run_id,
      '--from', spec.coordinator_handle,
      '--to', `dispatch:${spec.dispatch_id}`,
      '--type', 'status',
      '--subject', 'report requested',
      '--body', spec.body || 'Your turn ended without a worker_done. Post your report (and your verdict as a PR comment if you are a reviewer or tester), then send worker_done.',
    ];
  },

  describe(spec) {
    return `ask dispatch ${spec.dispatch_id} (${spec.assignee_handle}) for the report it never sent`;
  },
});

module.exports = executor;
if (require.main === module) {
  const spec = JSON.parse(process.argv[2] || '{}');
  console.log(JSON.stringify(executor.run(spec, { apply: process.argv.includes('--apply'), cycle: process.argv[3] }), null, 2));
}
