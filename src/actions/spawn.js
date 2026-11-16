#!/usr/bin/env node
// src/actions/spawn.js — start a worker for an eligible issue. The only action that CREATES load.
//
// Preconditions are unusually strict because this is the one action that consumes the machine:
//   * a free slot, read LIVE from src/capacity.js at decision time — never cached, and never a guess.
//     The machine's currently-occupied state is the condition this check exists to handle; nothing is
//     closed to make room for the measurement. If the number is zero, the spawn is refused, and that is
//     the correct behaviour: spawning a worker that does not fit is how workers died with "memory full".
//   * the issue must be labelled `agent` and must not already be covered by an open PR.
//   * SCENARIO 9, as a hard rule: the worker runs in its OWN worktree. `--worktree current` is the
//     coordinator's own worktree and is FORBIDDEN here — the executor refuses the spec outright rather
//     than passing the flag through, because a worker in the coordinator's tree edits the coordinator.
//   * the memory rule from the sandbox plan: at most 1 sandbox worker while live workers are running.
//
// The command is Orca's managed path (worker-start), not the external-terminal route: the supervised
// class is the one whose accounting converges, which is the whole point of scenario 8.
const { makeExecutor } = require('./_core.js');
const capacity = require('../capacity.js');

const executor = makeExecutor({
  name: 'spawn',

  preconditions(spec) {
    const missing = [];

    // SCENARIO 9 — the rule, enforced where it can actually stop something.
    const wt = String(spec.worktree || '');
    if (!wt) missing.push('no worktree given');
    else if (/^current$|--worktree\s+current/i.test(wt) || wt.toLowerCase() === 'current') {
      missing.push('SCENARIO 9: `--worktree current` is the coordinator\'s own worktree and is forbidden — workers run in their own worktrees');
    }

    // D1: capacity is READ LIVE at decision time, every time — see src/capacity.js. There is no cached
    // "this machine has N slots" figure and no expectation that anything was closed to make room; the
    // machine's real, currently-occupied state IS the condition this check exists to handle. Still
    // never a guess: if the live read fails, that is a missing precondition, not an assumed number.
    if (typeof spec.free_slots !== 'number') {
      try {
        spec.capacity = capacity.freeSlots();
        spec.free_slots = spec.capacity.free_slots;
      } catch (e) {
        missing.push(`capacity could not be read live: ${e.message}`);
      }
    }
    if (typeof spec.free_slots === 'number' && spec.free_slots < 1) {
      missing.push(spec.capacity
        ? `no free slot (${spec.capacity.available_mb} MB available, margin ${spec.capacity.margin_mb}, peak ${spec.capacity.peak_mb_per_worker} MB per worker)`
        : `no free slot (${spec.free_slots})`);
    }

    if (!spec.issue_number) missing.push('no issue to spawn for');
    if (spec.issue_label_agent !== true) missing.push('the issue does not carry the agent label');
    if (spec.issue_covered_by_open_pr) missing.push('an open PR already covers this issue');
    if (spec.already_dispatched) missing.push('a worker is already dispatched for this issue');

    if (spec.live_workers > 0 && spec.sandbox_workers >= 1) {
      missing.push(`sandbox limit: ${spec.live_workers} live worker(s) are running and this would be sandbox worker ${spec.sandbox_workers + 1} (max 1 while live workers run)`);
    }

    return missing;
  },

  alreadyDone(spec) {
    return spec.already_dispatched === true;
  },

  classify() { return 'supervised'; },

  argv(spec) {
    return ['orca', 'orchestration', 'worker-start', '--worktree', spec.worktree, '--agent', 'opencode'];
  },

  describe(spec) {
    return `start an opencode worker in ${spec.worktree} for issue #${spec.issue_number} (free slots: ${spec.free_slots})`;
  },
});

module.exports = executor;
if (require.main === module) {
  const spec = JSON.parse(process.argv[2] || '{}');
  console.log(JSON.stringify(executor.run(spec, { apply: process.argv.includes('--apply'), cycle: process.argv[3] }), null, 2));
}
