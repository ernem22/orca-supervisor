#!/usr/bin/env node
// src/actions/abandon.js — fence a worker that cannot finish. DESTRUCTIVE: it takes the work away.
//
// The preconditions here are the C2/C3 principle expressed as code, and they are the reason this file
// exists at all: a destructive action is permitted only with POSITIVE evidence and only when the work
// is PUSHED. Both halves are checked; either one missing refuses the action with the missing half named.
//
// A finding worth stating: for an EXTERNAL terminal (operator-created, not started by Orca) there is
// no fence to apply. Orca's worker-abandon only knows dispatches it supervises, and this executor will
// not invent a kill: an external worker is escalated to a human instead. That asymmetry is real and
// belongs in the E3 cutover plan, not in a workaround here.
const { makeExecutor } = require('./_core.js');

const executor = makeExecutor({
  name: 'abandon',

  preconditions(spec) {
    const missing = [];
    if (!spec.dispatch_id) missing.push('no dispatch_id');
    if (spec.evidence_kind !== 'positive') {
      missing.push(`evidence is ${spec.evidence_kind || 'absent'}, not positive — absence grants no authority (C2)`);
    }
    if (!spec.pr_number) {
      missing.push('the work is not pushed (no open PR for this task) — fencing could lose local-only work');
    }
    if (spec.liveness === 'exited') missing.push('the worker has already exited: nothing to fence');
    if (spec.klass === 'external') {
      missing.push('external terminal: Orca has no fence for an operator-created process, so this is escalated rather than improvised');
    }
    return missing;
  },

  alreadyDone(spec) {
    return spec.liveness === 'exited' || spec.abandoned === true;
  },

  classify(spec) {
    return spec.resource_state && spec.resource_state !== 'external' ? 'supervised' : 'external';
  },

  argv(spec) {
    return ['orca', 'orchestration', 'worker-abandon', '--dispatch', spec.dispatch_id];
  },

  describe(spec) {
    return `fence dispatch ${spec.dispatch_id} (${spec.assignee_handle}) — evidence: ${spec.evidence_reason || 'positive'}`;
  },
});

module.exports = executor;
if (require.main === module) {
  const spec = JSON.parse(process.argv[2] || '{}');
  console.log(JSON.stringify(executor.run(spec, { apply: process.argv.includes('--apply'), cycle: process.argv[3] }), null, 2));
}
