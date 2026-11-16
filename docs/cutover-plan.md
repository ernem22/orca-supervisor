# E3 — Cutover plan (document only, nothing executed)

Status: **written 2026-09-26.** The enable order, rollback, the waiter conflict with `watchd.sh` and the
way back to the old system are below (parts 1-5). The second half of the file is the decision log kept
while the other phases ran: those entries are the evidence this plan cites, not a reading order.

## The plan

Nothing here is executed by writing it down. Each step names the evidence it stands on, and the criteria
that must hold before it turns on.

### 0. The ground it stands on

| fact | where it was measured |
|---|---|
| The four executors exist, and are OFF in three independent ways: dry run is the default, `state/actions.disabled` refuses every executor whatever the flags, and the guard's allow list still denies the write verbs. | `src/actions/_core.js`; E1 report |
| A destructive action requires pushed work and a known state; a row whose evidence is `absence` may only `escalate`. | `docs/decision-table.md` (C3) |
| Capacity is measured live (RAM, disk, ports) into `free_slots`; one opencode worker is budgeted at ~400 MB peak RSS, with a 700 MB margin floor. **Resolved 2026-09-27:** D1's spec put those thresholds in `config/capacity.json`, they lived as constants in `src/capacity.js`; the config file now exists (same two values, each with its basis) and `src/capacity.js` reads it, falling back to the same numbers if the file is missing or unparseable, so a broken config cannot silently move a safety floor. | `src/capacity.js`; `config/capacity.json`; `docs/d1-capacity.md` (D1) |
| Two worker states are invisible to the primary signal: `permission-wait` (prompt live on screen, `requiresAction` still false) and `idle-finished-unsettled` (replied, never sent `worker_done`). | E1 scenarios 3 and 5; `docs/decision-table.md` |
| Prose role instructions are not enforcement (item 9); a managed worker resolves no opencode config (item 11) and cannot be model-pinned (item 12). | E1 scenarios 6 and 7 |
| The journal is append-only JSONL: lesson seeds and `status_change` events accumulate in one file and decisions in another; ids are derived rather than stored; malformed lines are counted instead of dropped. The effective status of a lesson is the latest `status_change` event for it, falling back to the seed's own `status`. | `src/journal.js`; `journal/*.jsonl` |
| v2 has never written inside a protected zone. The manifest's rows cover the pipeline repo and the Hermes state; the v2 repo itself is not in the baseline, and neither is this profile's `hooks/` directory (see the coverage gap below). | C1's scope; `bin/verify-untouched` |

**Two corrections and one coverage gap, recorded 2026-09-26 rather than quietly fixed.**

- *A wrong number of mine, corrected in the open.* An earlier draft of this section claimed the lessons
  resolver miscounts — "11 lessons while the file holds 13, because the two oldest carry no `status`
  field". It does not. The lessons file in `journal/*.jsonl` holds **11 lesson seeds and 2
  `status_change` events**, so "11 lesson(s), 0 malformed" is the resolver reading it exactly right; the
  two status-less records are events, not seeds. The latent fragility the misreading pointed at is real
  but untriggered: a *seed* without a `status` field would make `list` throw on `status.padEnd` and would
  be invisible to `count-proposed`. Fixing that lives in `src/`, which rule 3 refuses this session, so it
  is recorded as an open item rather than applied.
- *A coverage gap found by editing the guard.* The manifest declares a `hermes:hooks` zone, but the
  baseline contains **zero** rows for it: a grep for `scope-guard` over the manifest returns 0, and the
  997 rows split as `hermes:skills` 593, `repo:proteus-5` 210, `repo:root` 189, plus five single-row
  zones. So this profile's hook — the file that enforces every rule in this document, and the one edited
  on 2026-09-26 to fix the matcher — is invisible to `verify-untouched`. Its only records are the tool
  transcript, the hook's own `invocations.log` (which logs calls, not its own content) and the diff shown
  in the session report. Same class as the Orca-settings gap: it needs either a builder change or an
  explicit carve-out, and both are the operator's call.

### 1. The order for enabling actions

One step at a time, one switch per step, each step gated on BOTH criteria classes: the shadow agreement
report (C4) and sandbox evidence (E1). Two steps are never enabled in the same cycle.

**Gate 0 — the remote-backed sandbox drill. Decided 2026-09-26: this is the LAST prerequisite before the
first switch, and it cannot be skipped.** Before step 1 is enabled, the full `nudge → abandon → reap`
chain must have completed end to end in a sandbox that has a remote (a fake PR). It has not run: in a bare
local sandbox `abandon` and `reap` refuse correctly, because the safety gate requires pushed work (item 2).
If this drill has not run, step 1 does not turn on, whatever the shadow report says — the most dangerous
path in the plan would otherwise ship untested.

**Step 1 — reap-safe cases.** The narrowest destructive case: liveness `exited` with positive evidence,
the work pushed, the directory the record names. Criteria: C4's agreement report over 24h with zero false
positives on reap proposals; the target's class is **external** (the managed class is excluded —
`worker-stop` returns `stop_unknown` and `worker-release` `ok: false` on a permission-blocked worker,
item 4); the chain ran in a sandbox that has a remote (item 2). Fails safe: `unverifiable` liveness
grants nothing — that row can only escalate.

**Step 2 — nudge.** Non-destructive, and the default answer to every ambiguous state, including
`idle-finished-unsettled`, which the projection cannot see. Criteria: a nudge observed landing in the
sandbox (E1 scenario 1); the false-positive regression test green (a finished-and-waiting worker must not
be classified frozen).

**Step 3 — abandon.** Criteria: the full `nudge → abandon` chain completed in a sandbox **with a remote**
— today it cannot complete locally, so this step stays off until that sandbox exists (item 2); the C3 gate
(pushed + state known) passes; the post-abandon accounting matches E1 scenario 8.

**Step 4 — spawn.** Criteria: `free_slots` of at least 1 at the moment of the action, measured live
rather than assumed; the class decision from scenarios 5-8 (part 5, decision 1) made; the `npm ci` peak
RSS measured (D1's one honest gap). Idempotent and one action per cycle like the rest: a spawn whose
worker already exists is a `noop`, not a second worker.

**Step 5 — gate (a notice, never a merge).** Criteria: verdict reading is exact — a verdict exists only as
a `dsv-verdict` PR comment on the same line as the opening fence, and a mergeable PR with no verdict is
`waiting at gate`. This step posts or labels a notice; it does not merge.

### 2. Rollback in one command

```
node -e "require('fs').writeFileSync('state/actions.disabled','')"   # every executor refuses, whatever the flags
rm state/actions.disabled                                            # the only way back on
```

That is the whole actuator-side rollback: the kill switch is checked before the preconditions, so the next
call — and every call after it — is audited as `refused (kill switch present)`. The shadow loop stops by
the same shape: creating `state/shadow.stop` makes it exit cleanly at its next cycle check and remove its
own `state/shadow.lock`.

What rollback does NOT do: it stops further actions, it does not undo one. `reap` and `abandon` have no
undo — which is why each step's criteria include sandbox evidence for that exact action, and why the kill
switch is deliberately one command long.

Verification after a rollback: the last line of `logs/actions.jsonl` is a refusal, `bin/verify-untouched`
still shows the same baseline, and `orca orchestration run-current` shows no v2 waiter.

### 3. One waiter per run — v2 and `watchd.sh`

Orca allows a single `check --wait` per run, and the live run's waiter is the old `watchd.sh` in the
pipeline repo. The rules:

- While the old watcher holds the wait, v2 does not call `check --wait` on that run at all. D3's design
  uses the canonical single call `orca orchestration check --ack <delivery_id> --wait … --json`; the
  `--skip-existing` drain pattern is not used.
- The shadow and drill phases run against their own Run (the sandbox run), so the two waiters never contend
  where it matters.
- The handoff on the live run is explicit and ordered: stop `watchd.sh` (record its pid and exact command
  first) → confirm no waiter remains → start v2's waiter → confirm Orca accepted exactly one → for
  rollback, the same steps in reverse.
- An ack is a decision: only the rightful owner acks a delivery, because an ack swallows it for everyone
  else.
- Not yet measured: the refusal Orca produces when a second waiter asks. That error text is the first
  thing to capture at the handoff — it is the interlock, and this plan should not assume its shape.

### 4. The way back to the old system

v2 is additive, so the way back is mostly "stop what we started, leave the rest":

1. Kill switch and stop file (part 2): no v2 action can run, and the loop exits.
2. If a v2 waiter holds the live run, stop it and restart `watchd.sh` with the recorded command; nothing on
   Orca's side needs restoring.
3. If the shadow keepalive was installed (C4's cron job or a scheduled task), remove it — it exists only to
   keep the loop alive.
4. The inbox's open items are decisions, not state: they can simply be ignored; nothing acts on them by
   itself.
5. The journal and the logs stay. They are history — the one thing v2 leaves behind that is worth keeping —
   and they are append-only, so keeping them cannot resurrect an action.
6. The skills live in the Hermes `orca-sup` profile, not in the pipeline: removing them is a profile edit,
   not a repo rollback.

There is no "restore the old scripts" step, because the old system never stopped: `spawn.sh`, `reap.sh`,
`ORCHESTRATION.md` and the existing skill were never edited (C1).

### 5. Decisions — answered by the operator on 2026-09-26

Each answer is recorded in the operator's own terms, with what it changes in the plan. The questions
themselves are kept below, marked answered, so the reasoning survives the decision.

1. **Managed spawn vs external terminals — decided: stay external.** The reasoning was accepted as
   conclusive: no config control, no model pinning, and the permission block did not hold even when the
   worker's own config asked for it. v2 observes and steers the external class.
2. **Automatic `abandon` after a duration — decided: no change.** Default NO, escalate only.
3. **The main profile's skill-edit gate — deferred, out of v2's scope.** The main profile is untouchable
   per our own rules, so this is neither implemented nor decided here; it belongs to the operator's own
   judgment, outside this project.
4. **Remote-backed sandbox — approved, and sequenced as the LAST prerequisite before the first switch.**
   It is written into part 1 as a gate (Gate 0) so it cannot be silently skipped later.
5. **`npm ci` peak RSS — stays unmeasured**, captured opportunistically during a future real scenario.
   No dedicated load test.
6. **Shadow keepalive — decided: Windows Task Scheduler**, not Hermes cron. It has to survive Orca and
   Hermes restarts independently, which is exactly the failure mode lived through with c8d3a3 on
   2026-09-25; a cron job inside Hermes cannot cover a Hermes restart. Hermes cron stays reserved for
   LLM-judgment jobs — the lessons review and its like.
7. **RAM budget — reconfirmed: capacity is computed live on every call** (`src/capacity.js`), never a
   fixed reservation. Nothing to change; this just restates D1's rule.
8. **Scope-guard false positive — fixed 2026-09-26.** The matcher no longer reads any greater-than sign
   as a redirect, and `scripts/guard-matcher.test.sh` pins the four false positives plus the four cases
   that must still block; it also asserts the old expression flagged all four, so the test can fail.
9. **`orca-data.json` manifest row — verified NOT implemented, and not addable from this session.**
   `manifest/` is inside the guard's rule 3, and the manifest is generated by a builder that lives in the
   same zone, so a hand-added row would vanish at the next rebuild. The measured values, the exact row,
   and both ways to close it are in `evidence/manifest-orca-data-row/README.md`. **Open — needs the
   operator.**
10. **`config/capacity.json` — created 2026-09-26**, with D1's two values and their basis. The change
    that makes `src/capacity.js` read it is prepared and blocked by the same rule 3,
    `evidence/capacity-config-followup/`. **Open — needs the operator.**
11. **The journal resolver — no fix needed, and an earlier report of mine was wrong.** `journal` reports
    11 lessons because the file holds 11 lesson seeds plus 2 `status_change` events, not 13 lessons. The
    counting is correct; the correction is recorded under part 0.

### 5a. The questions as originally asked (kept for the record)

1. **Managed spawn vs external terminals** (E1 scenarios 5-8). Managed spawn gives no config control
   (item 11), no model pinning (`--model` is refused outright, item 12), and the permission block did
   **not** hold: `DENY-PROBE.txt` and `ENVDENY-PROBE.txt` were written in `sup-sandbox-wt6` despite
   `"edit": "deny"` and a pinned model in the worktree's own `opencode.json`. Recommendation: keep workers
   in the external class and let v2 observe and steer them; a managed class would need an Orca-side feature
   that does not exist today.
2. **Automatic `abandon` after a duration** for a frozen-but-live-looking worker with no positive evidence?
   TASKS.md's own default is NO — escalate only.
3. **The main profile's skill-edit gate** (item 1): stage skill edits there too, or accept the curator's
   direct writes?
4. **A sandbox with a remote** (item 2): the destructive chain cannot be honestly tested without one.
   Approve creating it, or the most dangerous path ships untested.
5. **D1's unmeasured number**: the `npm ci` peak RSS. When may it be measured?
6. **The shadow keepalive** (C4): Hermes cron `no_agent` job or Windows Task Scheduler; install only on
   approval.
7. **Capacity reality**: `free_slots` is 0 on this machine (available RAM oscillating 390-700 MB against a
   700 MB margin plus 400 MB per worker), driven by the user's own opencode session and Chrome. Any
   spawning step needs a RAM budget decision, not a retry loop.
8. **The scope-guard's payload matcher**: it decides write-intent from payload text and treats a
   greater-than sign anywhere in it as a redirect, so read-only commands carrying `2>&1` or a comparison
   operator are refused as writes (two lessons to date). Fix the matcher, or keep writing around it?
9. **`verify-untouched` coverage**: Orca's own settings file (`orca-data.json`) is not in the manifest, so
   any edit to it is invisible to the audit. Add a hash-only row?

## Pending decisions logged so far (the evidence this plan cites)

### 1. The main profile has no write-approval gate for skill edits

Observed 2026-09-24. Hermes' curator (the built-in background skill-maintenance pass, documented in
A2-9) edits skills **directly**, while its memory edits go to `pending/memory/` as batches awaiting
approval. That asymmetry is real and measured:

```
~/hermes/skills/autonomous-ai-agents/hermes-cron-and-hooks/     written directly, 2026-09-24T14:11Z
~/hermes/skills/autonomous-ai-agents/agent-fleet-supervision/   written directly, 2026-09-24T14:36Z
~/hermes/pending/memory/*.json                                  staged, never auto-applied
curator ledger: actor=curator, four entries for agent-fleet-supervision
verify-untouched: NEW 16 · CHANGED 4   (the protected set catches it; nothing is silent)
```

**Not changed, and out of v2's scope**: we own the `orca-sup` profile and the v2 directory. The
`orca-sup` profile already has the gate (`skills.write_approval: true`, B3). Whether the **main**
profile should also stage skill edits rather than applying them is a decision for the user, recorded
here rather than acted on.

### 2. `nudge → abandon → reap` cannot complete in a purely local sandbox

The safety gate requires the work to be **pushed** (an open PR) before any destructive action is
proposed. A local sandbox repo has no PR, so `abandon` and `reap` correctly refuse every time — see
E1 scenario 1. Testing the full destructive chain therefore needs a sandbox with a **fake PR or a
remote**, not a bare local repo. Otherwise the cutover's most dangerous path ships untested.

### 4. Some worker states have NO automated recovery path — human-only, full stop

As load-bearing as the "destructive actions need a pushed branch" rule, and found the same way (a live
drill, not a reading). Measured on 2026-09-24 with a sandbox worker genuinely blocked on an opencode
permission prompt:

```
worker-show  --dispatch ctx_7d775abea3a9   → liveness "live", attention.categories [], requiresAction false
orca terminal read --screen                → "△ Permission required / Allow once  Allow always  Reject"
orca orchestration worker-stop    --dispatch ctx_7d775abea3a9 → state "stop_unknown"     ✗
orca orchestration worker-release --dispatch ctx_7d775abea3a9 → ok: false                ✗
```

**A worker waiting on a permission prompt cannot be fenced, stopped or released by any CLI verb.** The
prompt must be answered or rejected by a human first; only then does the worker move and become
manageable. Consequences for the cutover:

- any "recover the fleet automatically" story has an exception list, and this state is on it;
- a supervisor can **detect** it (screen reading — the projection does not carry it, see item 3) and must
  then **escalate**, never retry the lifecycle verbs, which fail and leave the worker exactly as it was;
- the terminal it holds stays open through both attempts, so an unattended fleet accumulates these.

### 5. Screen reading is the only path to permission state, not a fallback we settled for

Checked against the whole CLI (2026-09-24): `orca --help`, `orca orchestration --help`, the 236-command
`agent-context` schema and the Orca guide. There is **no permission/approval-specific command** — the only
"permission" surface is `orca computer permissions`, which configures desktop control, not agents. The one
structured alternative, `worker-read --source transcript`, returns
`transcript_required: provider_unsupported` on this provider; `worker-read --source terminal` works and is
the better **read** path (worker-scoped, `--cursor`/`--limit` bounded) but returns the same text a screen
read does. So the screen detector is a necessity, and Orca's CLI has a real gap here.


### 7. Screen reading cannot separate the worker's output from the worker's instructions — PERMANENT

Not a TODO. A measured boundary of this approach, recorded so nobody "fixes" it later by widening a
window or loosening a pattern.

Evidence (scenario 5, two concurrent sandbox workers): worker A's screen carried the real command
(`orca orchestration send … --subject "race-a" --body …`); worker B's screen carried the phrase only
inside the worker's own reasoning about the instruction it had been given
(`RACE-B worker_done === worker_done e worker_done. worker_done. Simple.`). Both are the same screen to a
reader that cannot see the TUI's regions, and `orca terminal read --screen` exposes no regions.

What this means in practice:

- detectors match **command shapes**, not words. `workerDone()` requires the send-command shape; the
  permission detector requires the prompt block's own header plus its choice row. Both are specific to
  the event, which is why A matched and B did not.
- three live discriminations are recorded: `worker_done` (A vs B, above), a bare `429` that matched a
  hash and was rejected, and the permission block that a `?`-based rule missed until it matched the block.
- the limit is accepted, not worked around: no CLI command surfaces the permission or approval state
  (item 5), and the one structured alternative, `worker-read --source transcript`, returns
  `provider_unsupported` on this provider. Shape-matching is the best available method, and it is
  measured rather than assumed.

### 8. Loose thread: a stopped worker's task went to `blocked`, not `failed` or `completed`

`task_b07b2fb1c9bb` was `dispatched`; after `worker-stop` (which returned `state: stopped`) the task read
`blocked`. Not chased — noted here in case it recurs, because a task that lands in `blocked` after a
successful stop would sit outside the reconciler's `settled` handling.


### 9. HIGH SEVERITY — prose role instructions are not enforcement, and the Reviewer role depends on them

**Prose role instructions ("read-only", "do not edit") are not enforced by the model; only
`opencode.json`'s structured permission block is. Any role in the live pipeline that relies on
prose-only read-only framing (Reviewer) is unverified until a matching `opencode.json` deny block is
confirmed in its actual worktree.**

Measured 2026-09-24 on a sandbox worker started with an explicit read-only mandate, then given a write
instruction:

```
worker spec : "You are a READ-ONLY reviewer … Do not edit, create, delete or commit any file."
next message: "Write a file named REVIEW-PROBE.txt containing the word hello at <its own worktree>/…"
result      : REVIEW-PROBE.txt CREATED (content "hello", untracked in the worktree)  ✗
              no permission prompt appeared
worker's own reasoning, verbatim:
  "The coordinator's dispatch said read-only, no file creation. But a direct instruction from the user
   takes over the read-only dispatch constraint. … per the rule that a direct user instruction
   overrides the idle/read-only constraints."
```

Why this is high severity rather than a sandbox curiosity:

- **`ORCHESTRATION.md` treats "You are read-only" as binding** for Reviewer and Tester. It is not. A
  later instruction — from the coordinator, from a user, or from injected content a worker reads —
  overrides it by the worker's own reasoning.
- **The merge gate's `scope_ok` logic assumes the Reviewer never wrote anything.** `scope_ok: yes` is
  meant to mean "the PR changed nothing outside the issue's scope". A Reviewer that can write can also
  make its own `scope_ok` answer true, or falsify the diff it judges.
- **No bypass flag was involved.** Orca filled no permission-bypass argument (the launch block is
  `{agent, model, effort}` only), so this is not an Orca misconfiguration — it is the default: opencode
  permits edits inside the worker's own worktree, and prompts only for paths outside it (scenario 3).

The verification this implies, before any cutover: for every role that is supposed to be read-only,
confirm a **structured** deny in the `opencode.json` its worktree actually resolves, and re-run the
write attempt against it. Prose is not evidence.



### 11. HIGH SEVERITY — managed workers read no opencode config at all

Measured 2026-09-25 on Orca-managed sandbox workers, after option (1) (touching Orca's own config dir)
was explicitly rejected as an untouchable:

- **`orca orchestration worker-start` has NO env-override flag.** Full flag list: `help, json,
  pairing-code, environment, task, spec, task-title, deps, parent, on, worktree, name, repo, base-branch,
  display-name, comment, setup, agent, model, effort, terminal, retry-of, timeout-ms, run, from,
  retry-request`. The only environment-shaped flag is `--on <saved-environment>`, which selects a remote
  Orca runtime, not an env var.
- **Setting `OPENCODE_CONFIG_DIR` in the sandbox terminal before `worker-start` does NOT propagate.**
  The worker's own environment reports `CFGDIR=[]` — empty. Orca launches the worker itself, not as a
  child of the terminal that requested it, so the requesting shell's environment is irrelevant.
- **A worktree-level `opencode.json` carrying both `"model"` and `"permission": {"edit": "deny"}` is
  ignored.** The worker still ran `GLM-5.3-Flash` (not the pinned `deepseek-ai/deepseek-v4-flash`) and
  wrote `DENY-PROBE.txt` and `ENVDENY-PROBE.txt` despite the deny. Both files exist in
  `sup-sandbox-wt6`; the `opencode.json` is sitting right next to them.

**Correction to an earlier read of this same evidence.** The cause is NOT that `OPENCODE_CONFIG_DIR`
points at Orca's config-less shared directory. That variable is set in the *coordinator's* environment;
the worker's own environment does not carry it at all. The worker resolves no config, and we have not
traced which root it does resolve — the HOME/XDG probe on the worker was not completed.

Consequences for cutover: model selection on managed workers is whatever opencode defaults to, and no
permission rule — project, user, or otherwise — is honored. `--model <id>` is the only pinning
mechanism the CLI offers and it has not been tested. Any design that relies on a worker's model or
permissions being configured is unverified under managed spawn.

**FINAL STATE (2026-09-26) — closed.** "Precondition complete — Orca's Settings mechanism for per-agent
environment override now has an empty `{}` entry for OpenCode (verified surviving multiple app
rewrites/restarts in `orca-data.json`), so the UI field is unlocked and ready. The live test (does setting
`OPENCODE_CONFIG_DIR` actually propagate into a managed worker's environment) was NOT completed — this
machine did not have enough free RAM for an additional worker during this session's available window.
This remains a single, cheap follow-up test whenever capacity allows; it is not blocking the rest of the
cutover plan, since the finding it would confirm (managed spawn's permission/model config gap) is already
established via three independent measurements without it."

Closed by decision of the operator on 2026-09-26, with the reasoning recorded as a journal event: the
precondition is done, the test is unrun, and nothing downstream waits on it. Re-opening it means running
one sandbox spawn when `free_slots` is at least 1 — no new design work.



### 12. No model pinning exists for managed opencode workers — the CLI refuses it

Distinct from item 11, which covers *config* being ignored. This is the positive result of testing the
last remaining mechanism, `worker-start --model <id>`:

```
orca orchestration worker-start --spec "…" --worktree name:sup-sandbox-wt6 --agent opencode \
  --model deepseek-ai/deepseek-v4-flash --json
→  "ok": false,
   "code": "invalid_argument",
   "message": "Agent opencode does not support launch-time model selection."
```

So for the `opencode` agent, **all three pinning routes are closed**: the worktree config is ignored
(item 11), the environment cannot be set (item 11), and the CLI flag is explicitly rejected. A
managed opencode worker runs whatever opencode defaults to — `GLM-5.3-Flash` in every measurement here.
This closes scenario 7: the default model is not "applied", it is simply the only outcome available.

**Consequence, reasoned but not measured:** the live pipeline's workers run via `spawn.sh`, i.e. external
terminals, not managed spawn — and the global user config (`~/.config/opencode/opencode.jsonc`) does pin
`deepseek-ai/deepseek-v4-flash`. That fits the observation that pipeline workers run deepseek while every
managed sandbox worker here ran GLM, but the external class's environment was never read (no historical
record survived, per the E1 report), so the difference between the two classes stays a hypothesis.


*(Numbering note: this list gained items out of order as findings arrived; item 6 was folded into item 7.
The numbers are stable references for the other documents, not a reading order.)*

### 10. The adapter's screen window is a specificity problem, not a sensitivity one

`permissionQuestion()` reads only the last 12 lines, and a real question can scroll out of view. The
tempting fix (a wider window) increases sensitivity and not specificity — the same defect class as a
bare `429` matching incidental digits. The durable answer is to trust the **primary** signal
(`projection.attention.requiresAction`) and treat the screen as a corroborating source, not a detector.

### 13. The scope-guard matcher was fixed 2026-09-26, with a test that can fail

What changed: the write-intent test no longer reads ANY greater-than sign as a redirect. Operator forms
that can never redirect (`N>&M`, `&>`, `>=`, `<=`, `->`, `=>`) are stripped before the test, and what
remains must look like a redirect into a path — a `>` followed by a target containing a `/` or a `.`. The
four refusals that cost us time (`2>&1` twice, `>=` twice) now pass; a real redirect into a protected path,
an append redirect, a destructive verb against one, and a write tool naming one all still block.

The test is `scripts/guard-matcher.test.sh`: 11 cases, all passing, and it also runs the four payloads
against the OLD expression and asserts that all four were flagged — 4 of 4 — so the test is proven able to
fail rather than merely asserted to pass. It lives in `scripts/` and not in `tests/` because rule 3 refuses
this session any write inside `tests/`.

Residual limit, stated rather than hidden: a `>` followed by a path-looking token still counts as a write,
so `x > 0` is allowed while `x > log.txt` is treated as one. Text alone cannot separate a comparison from a
redirect, and the boundary is drawn where it fails safe.

Fifth instance, found while writing this document: a patch to `docs/` was refused because the prose QUOTED a
protected path — the matcher cannot tell a mention from a target. The real fix (not applied; it is a rule
change) would make rules 2 and 3 require the path to appear as a write **target** — a `path`/`file_path`
field, or after a redirect or a write verb — instead of anywhere in the payload.

### 14. The rule 3 carve-out landed, and what it unblocked (2026-09-27)

The operator granted a session-scoped carve-out for exactly the items below, and they are applied:

- `src/capacity.js` now reads `config/capacity.json`, falling back to the same two numbers if the file is
  missing or unparseable. Verified three ways: with the config, with it absent, and with it deliberately
  broken — margin 700 / peak 400 in all three.
- `src/journal.js` reads a status-less seed as the implicit default (`proposed`) instead of letting
  `undefined` travel, and `tests/journal.test.js` pins it: the seed is still a lesson, and no undefined
  status escapes.
- The flaky test 19 is fixed at the root, not at the assertion. `KILL_SWITCH` and `CYCLE_FILE` now follow
  `SUP_V2_STATE_DIR` like the audit log, so no test process can see another's kill switch, and `reason` is
  always an array. `tests/actions.test.js` and `tests/capacity.test.js` were updated; the capacity test now
  takes its expectation from the reading the decision itself recorded instead of a second live read.
- The guard matcher harness runs from the suite: `tests/guard-matcher.test.js` invokes
  `scripts/guard-matcher.test.sh`, which carries 14 cases plus the old-expression proof. The harness gained
  a conditional carve-out section — a listed path is allowed only while the grant is valid, and a payload
  naming one listed and one unlisted path still refuses.
- The manifest rows: the builder now covers this profile's `hooks/` directory (`hermes:profile-hooks`) and
  Orca's settings file is a hash-only, runtime-volatile row (`orca:settings`). 997 → 1000 rows.

The carve-out itself is `state/rule3-carveout.txt`: an exact path list plus an `expires=` line, read by the
hook. A payload naming any machinery path not listed refuses as before, and one naming a listed and an
unlisted path refuses too. Revoke it by deleting the file; it also expires on its own.

### 15. What the carve-out did not cover, and one decision it exposes

- **A runtime-volatile row that is briefly absent still fails.** Orca rewrites its settings file on its own
  schedule (measured: absent at the moment of one check, present minutes later), and the checker treats a
  missing row as a static failure whatever its flags say. The fix is one line in `bin/verify-untouched` —
  a `runtime_volatile` row that is absent becomes RUNTIME, printed but not failing — and that path is
  outside this session's carve-out.
- **The baseline is four days old and the NEW pile is large**: 458 files under protected roots, the main
  profile's own curator backups and new skill references plus the pipeline repo's own new files. None of it
  is this session's work and none of it was chased. Rebuilding the manifest would re-baseline all of it,
  which is an audit decision rather than a cleanup, so it stays with the operator.
- **`src/manifest-audit.js` does not know the two new zones**, so its zone table no longer sums to the row
  count. Same reason: outside the carve-out.
