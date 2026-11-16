# Decision table (C3) — "what I would do", and nothing more

`src/reconcile.js` reads a snapshot + a classification and emits **proposals**. It executes nothing.
No `orca` write command appears in this file, and none may be added: a reconciler that acts is a
different component with a different approval.

Every row of output carries:

```
{ action, target, reason, safe, preconditions[], evidence_kind: "positive" | "absence" }
```

### Where the projection is not enough — a confirmed pattern, not a one-off

Orca's `projection` block (`worker-show --dispatch <id>` → `result.projection`) is the primary signal,
and it is **unreliable for at least two real worker states** — both measured on live sandbox workers,
2026-09-24:

| state | projection says | screen shows | measured how |
|---|---|---|---|
| `permission-wait` | `liveness: live`, `attention.categories: []`, `requiresAction: false`, `nextAction.kind: none` | `△ Permission required / Allow once  Allow always  Reject` | two different workers, both with a live prompt on screen |
| `idle-finished-unsettled` | `liveness: live`, `requiresAction: false`, `nextAction.kind: none` | the turn's answer with no `worker_done` | worker replied `RACE-B` and never reported; projection still said live/none |

So for these states **screen-based detection is PRIMARY, not a fallback.** That is the reverse of the
signal order the C2 brief assumed, and it is now the design: the projection decides when it has
something to say (it *did* flag a transport-disconnect with `requiresAction: true`), and the screen
decides when it does not. A row whose class came from the screen carries `evidence_kind: positive`
because a transcript is the thing itself, not a projection of it.

The screen has its own permanent limit — see the cutover plan, item 7: it cannot tell "the worker said
X" from "the worker was told X", so detectors match **command shapes** rather than words.

## The principle that decides everything below

**No destructive-action proposal without positive evidence.**

Positive evidence is one of exactly three things:
1. Orca's `projection.liveness` is `exited`;
2. the worker's own process-exit observation;
3. a transcript whose last turn ended **without** `worker_done`.

`unverifiable` is **absence of evidence**, not evidence of a problem. It grants no stop, abandon,
retry or release authority, and any row resting on it may only `escalate`.

### The conflict this table resolves (decided by the user, 2026-09-23)

| rule | source | status |
|---|---|---|
| "a frozen progress counter is a **definite** stall → abandon the worker" | the old `ORCHESTRATION.md` pipeline doc | **does not carry over to v2** |
| "no destructive action without positive evidence; a frozen counter is a **suspect**" | the Orca orchestration guide (lines 136-143) | **wins, permanently** |

Why the Orca rule wins: a frozen counter is an *observation about a counter*, not about the worker.
The same signature appears when a worker has finished and is waiting to be collected — which happened
here at 14:48 and was the false positive that motivated this layer. The old rule read absence as
evidence; this table refuses to. **`working-frozen` therefore produces exactly one thing: an
`escalate` row and a `stall-suspected` inbox item.** No auto-abandon, ever, by default — the user
confirmed NO on 2026-09-23, escalate only.

## Actions × classes

| class | evidence | action | safe | preconditions |
|---|---|---|---|---|
| `settled` | positive | `reap` | yes | the task is terminal and its terminal still exists; nothing is running |
| `settled` **with** an open PR and no verdict comment | positive | `gate-ready` | yes | the PR is mergeable and its checks passed — a notice, not a merge |
| `idle-finished-unsettled` | positive | `nudge` | yes | the turn ended and no `worker_done` was sent — ask for the report, collect later |
| `provider-disconnect` | positive | `nudge` → `abandon` → `reap` | yes* | *only if the work is pushed; see below |
| `permission-wait` | positive | `escalate` | n/a | a human must answer; the reconciler must not answer for them |
| `rate-limited` | positive | `escalate` | n/a | wait it out; a retry attempt is not burned by a rate limit |
| `working` | positive | *(none)* | n/a | leave it alone |
| `working` | **absence** | `escalate` | n/a | liveness was unverifiable; say so, do nothing else |
| `working-frozen` | **absence** | `escalate` | n/a | suspect only — the inbox item carries the evidence path |
| `zombie` (dispatched, terminal gone) | positive | `abandon` → `reap` | yes* | *only if the work is pushed; otherwise `escalate` |
| `orphan-dir` | positive | `escalate` | n/a | a directory to LIST. Never a delete — the pipeline does not own every directory on disk |
| free slot + eligible issue | — | `spawn` | yes | see eligibility below |

### The safety gate on destructive actions

`abandon` and `reap` are destructive: they fence a process and take a terminal away. They are proposed
only when **both** hold:

- **the work is pushed** — the task's PR exists in the snapshot, so the branch is on GitHub and no
  local-only work can be lost by fencing;
- **the state is known** — the classification carries positive evidence.

Otherwise the row degrades to `escalate` with the reason recorded. A destructive proposal that cannot
name both is not a cautious proposal; it is a guess with a verb attached.

### Spawn eligibility

`spawn` is proposed only when all three hold:
1. a **free slot** exists (capacity is D1's job; the reconciler consumes its answer, it does not guess);
2. an **eligible issue** exists — labelled `agent`, no file/area conflict with an open PR, and its
   model not exhausted;
3. the issue is not already covered by an open PR.

If no slot is free, the row is `escalate` ("capacity"), not a queue position. The reconciler does not
maintain a queue: a queue is state, and state is re-derived.

## What this file deliberately does NOT contain

- Any execution path. `reconcile.js` requires no process gate because it starts no process.
- Any timing policy: how long a suspect may sit before a human is paged is a D1/E3 decision.
- Any auto-abandon rule, at any duration. Escalate only.
