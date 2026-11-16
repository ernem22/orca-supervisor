#!/usr/bin/env node
// src/actions/reap.js — collect a settled worker's terminal. DESTRUCTIVE for the terminal, not the work.
//
// Two classes, because Orca treats them differently and pretending otherwise is how accounting drifts:
//   supervised  a worker Orca started        -> worker-release gives the terminal back, accounting converges
//   external    an operator-created terminal -> Orca does not release what it did not create. The old
//               reap logic is re-implemented here as new code (the existing reap.sh is NOT called).
//
// The external path is deliberately narrow: it closes the terminal and reports the accounting
// consequence. It does not delete a worktree — that is hygiene, it is listed rather than executed
// (C1), and it is the user's call.
const { makeExecutor } = require('./_core.js');

const executor = makeExecutor({
  name: 'reap',

  preconditions(spec) {
    const missing = [];
    if (!spec.task_id) missing.push('no task_id');
    if (!spec.terminal_handle) missing.push('no terminal handle to collect');
    if (!spec.task_terminal) {
      missing.push(`task status is ${spec.task_status || 'unknown'}: only a settled task may be collected`);
    }
    if (spec.worktree_is_coordinator) {
      missing.push('the terminal belongs to the coordinator worktree — never reaped');
    }
    return missing;
  },

  alreadyDone(spec) {
    return spec.terminal_exists === false;
  },

  classify(spec) {
    return spec.resource_state && spec.resource_state !== 'external' ? 'supervised' : 'external';
  },

  argv(spec) {
    if (spec.resource_state && spec.resource_state !== 'external') {
      return ['orca', 'orchestration', 'worker-release', '--dispatch', spec.dispatch_id];
    }
    // External class: the new code, not reap.sh. Closing the terminal is all Orca offers here; the
    // release call was measured to leave these records as `not_requested`, so it is not pretended.
    return ['orca', 'terminal', 'close', '--terminal', spec.terminal_handle];
  },

  describe(spec) {
    const klass = spec.resource_state && spec.resource_state !== 'external' ? 'supervised (worker-release)' : 'external (terminal close; accounting will not converge)';
    return `collect the terminal for task ${spec.task_id} — ${klass}`;
  },
});

module.exports = executor;
if (require.main === module) {
  const spec = JSON.parse(process.argv[2] || '{}');
  console.log(JSON.stringify(executor.run(spec, { apply: process.argv.includes('--apply'), cycle: process.argv[3] }), null, 2));
}
