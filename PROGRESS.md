# PROGRESS — orca-supervisor v2

Last updated: 2026-09-21 (A0)
Job file: `docs/TASKS.md` (sha256 `bfdf0783ff3ec386c4de7743b52fa602f8f6a3fe03b417f7a94f376b078774b3`)

## Version note application

- The earlier Turkish `TASKS.md` / `TASKS-EK1.md` were **never copied** into this workspace
  (`D:/code/orca-supervisor/` did not exist before A0), so there was nothing to rename to
  `docs/TASKS.tr.md`. Nothing was deleted.
- `docs/TASKS.md` = byte-identical copy of `D:/code/design-system-viewer/Supervisor_v2.md`
  (both sha256 `bfdf0783ff3ec386c4de7743b52fa602f8f6a3fe03b417f7a94f376b078774b3`).
- A0 was **not** already done; it was executed in this step.

## Step status

| Step | Status | Note |
|---|---|---|
| A0 workspace + manifest | **done** | baseline-2 active (989 files); baseline1 archived |
| A1 skeleton + exec gate | **done** | 17/17 `node --test` |
| A2 capability discovery (14 items) | **done** | see report; item 3 (`check --all`) has a deadlock, item 13 partly unknown |
| A2b Orca guide as evidence | **done** | `evidence/A2b/orchestration-guide.md` (197 lines) + `worker-start-help.txt` |
| A3 profile `orca-sup` | **done** | created empty, isolated, SOUL 646 B; hello test passes; pin test answered; credential added by the user |
| B1 lossless state model | **done** | `docs/state-model.md`, `src/checkpoint.js`, `tests/checkpoint.test.js` (9 tests), real `handoff.md` (836 B) + 6 seeded decisions |
| B2 lossless compression | **done** | `docs/compaction-design.md` + `evidence/B2/compression-settings.txt`; main config hash unchanged (`e5429c76…` MATCH); no setting changed |
| B3 controlled self-improvement | **(a)(b)(c) done**; (d)(e) designed/listed, awaiting approval | runbook 4 543 B + reference, both load; runbook pinned **and** under `skills.write_approval: true` (gate proven); `journal/lessons.jsonl` 7 seeds; job `sup-lessons-review` **paused**, one manual run completed, scope locked by `enabled_toolsets:["web"]` + a `pre_tool_call` scope hook; `docs/pruning-design.md` + `docs/memory-proposal.md` (1 768/2 200 and 682/1 375 chars) |
| C1 snapshot layer | **done** | `src/snapshot.js` + `docs/snapshot-schema.md`; the projection source was wrong twice and the drill caught both — it is `worker-show` → `result.projection` |
| C2 classifier | **done** | `src/classify.js`; a frozen counter is a suspect, never proof (the Orca-guide principle beats the old ORCHESTRATION.md rule) |
| C3 reconciler | **done** | `src/reconcile.js` + `docs/decision-table.md`; **two states where the projection is unreliable** (permission-wait, idle-finished-unsettled) → screen-based detection is primary there, not a fallback |
| C4 shadow loop | **done (window shortened, honestly labelled)** | 22/22 clean cycles, one degraded sampling window logged, zero false positives on loop behaviour; **zero live events occurred** (dormant pipeline) → event classification deferred to E1. An "empty window", not "passed validation" |
| D1 capacity | **done** | `src/capacity.js` reads the machine live on every call, never cached; **closing answer `free_slots = 0`** (915 MB available − 700 margin ÷ 400 MB peak). `npm ci` peak left as an honest unmeasured gap — `docs/d1-capacity.md` |
| D2 spec generator + linter | **done** | `src/spec-gen.js` + `src/spec-lint.js` + 10 tests; found 4 linter defects of its own |
| E1 sandbox scenarios | **done** | scenarios 1–10 all run, raw output written up in `docs/e1-scenarios.md`. Found: prose read-only is **not** enforcement; no permission-bypass flags; **no model pinning at all** (config ignored, no env flag, `--model` refused); screen reading is the only path for permission-wait; some worker states have no automated recovery |
| E2 compaction drill | not started | next |
| E3 cutover plan | not started | document only; depends on E2 |
| F1 harness experiment | not started | |

## A1 follow-up status (items 1–8)

| # | Item | Status |
|---|---|---|
| 1 | annotate curator-caused CHANGED rows with the ledger entry | **done** — `verify-untouched` prints `explained by curator ledger: <actor>/<action> at <ts> (session …)` or `no curator ledger entry for this row`; rows still FAIL |
| 2 | curator backups + SKILL.md diff + first 60 lines of the new reference | **done** — the curator HAS a backup feature (`hermes curator backup`, pre-run tar.gz per its doc) but **no skill backup exists on this machine** (`list-archived`: none; `backups/` holds only config.yaml copies) → pre-patch content is **not recoverable**, only the ledger's before-sha256 |
| 3 | what the curator is (trigger, scope, backups, per-profile, orca-sup) | **done** — see report; scoped to `created_by: "agent"` skills, never deletes, pinned skills exempt, consolidate off by default |
| 4 | cron jobs: definition static (FAIL) vs runtime volatile | **done** — per-job `definition_sha256` (FAIL) + `runtime_sha256`; the jobs.json file row is `runtime_volatile` |
| 5 | real timestamps in actions.log + `logAction()` | **done** — `src/log-action.js`; the placeholder was in the A0 chat report, not the file; the hand-typed A1 lines were corrected from file mtimes |
| 6 | guard hardening + two new tests | **done** — `node` only for v2 entry points, `npm ls` only; `tests/single-exit-gate.test.js` and `tests/manifest-loud-fail.test.js` |
| 7 | full `comment` field on the coordinator worktree | **done** — see report; it is a design note, not a live mechanism |
| 8 | what changed in the Orca task counts | **done** — Orca's own supervision: `stage.detail: process_exited`, `liveness.verdict: exited`, `attention.requiresAction: true`; the task returned to `ready` |
| (a) | refresh as baseline-2, archive baseline1, fix symlink gap | **done** — 989 files; `hermes/skills/orca-cli` → `C:\Users\user\.agents\skills\orca-cli`, 1 file behind it, now covered |
| (b) | volatile ONLY for `.curator_ledger.jsonl` + `.usage.json` | **done** — `processes.json` and the kanban lock are static again (they will FAIL on change, as decided) |
| (c) | no cron; run 3 stays pending | **done** — no job created |

## Pending stability runs

- **Run 2 (+30 min)** — done: 989/989 UNCHANGED (`evidence/A0/stability/run2-after30min.txt`; the first
  capture was empty because it landed while `verify-untouched` was mid-edit — noted in the file).
- **Run 3 (after `skill-distill-and-prune`)** — **DONE**, `evidence/stability-run3/`. The job ran
  `2026-09-22T04:08:35+03:00`, `last_status=ok`, and it **did edit the skill** (8 `agent/patch` entries
  in session `cron_40ef03042e7d_20260922_040000`). Results vs baseline-2: 984 UNCHANGED, 2 VOLATILE
  (curator bookkeeping), 1 RUNTIME (the cron file itself), **3 CHANGED** (all skill files, 66 ledger
  annotations attached), **1 CRON_DEF** — which turned out to be a **bug in my own field split**:
  `repeat` is a hybrid (`repeat.times` = definition, `repeat.completed` increments per run), so every
  cron run reported a false definition change. Fixed: `repeat` is in neither list, with
  `repeat_times` hashed as definition and `repeat_completed` as runtime. Re-verified: `MATCH`.
  **Manifest is now baseline-3** (990 files); baseline-2 archived as `manifest/protected.baseline2.json`.

## HARD REQUIREMENT for B3 (do not design around pin alone)

The resident `orca-sup-runbook` skill must be **BOTH pinned AND created/kept under
`skills.write_approval: true`**. Reason: the throwaway test proved pin only exempts a skill from
curator auto-transitions and LLM passes — an agent-side `skill_manage` patch went through anyway
(`{"success": true, …}` on a pinned skill). Pin alone is not a guard against self-edit.
**Any B3 design that relies on pin alone is rejected.**

Also carried forward:
- D3 must use process-exit `notify_on_complete`, not watch patterns (8-match lifetime cap, fired twice).
- Profile memory is 2200/1375 chars → B3(e) must be tiny.
- The coordinator worktree `comment` (auto scan creation, webhook triggers, budget caps) contradicts
  ORCHESTRATION.md and is not implemented — data for the user, not a spec.
- `check --all` stays forbidden on the live Run; C1 must not rely on it (E1 proves it on the sandbox).

## Baseline history

```
protected.baseline1.json  2026-09-21T15:30:46Z   987 files
protected.baseline2.json  2026-09-21T16:31:47Z   989 files
protected.baseline3.json  2026-09-21T16:47:49Z   990 files
protected.json (b4)       2026-09-22T13:39:08Z   990 files   <- active
```
PART-1 item 3 stop condition, explicitly closed: **0 tasks created since 2026-09-21T15:34:33Z**
(newest task `task_c23d87eea0c9`, created 2026-09-21 09:23Z local; 0 dispatched tasks now), so
**no worker was ever launched via `worker-start --agent`** — every dispatch in the window and before
it is `projection.resource.state: external` (operator-created terminal).

## Correction (2026-09-22, from the user's PART-1 item 3 challenge)

The B1 closing report said *"15:47Z'de denediğim reviewer-93b / tester-93b spawn'ları"*. That time was
**wrong — a local-vs-UTC mixup**. The evidence:

- `spec_reviewer_93b.md` mtime = `2026-09-21 15:44:55 +03:00` = **12:44:55Z**; the spawn ran within the
  following minute, so **~12:45Z on 2026-09-21**, not 15:47Z.
- A0's first `logs/actions.log` line is `2026-09-21T15:24:51Z`, and the guard's first `logs/exec.log`
  line is `2026-09-21T15:57:38Z`. So the spawn happened **~2h40m before the v2 workspace existed** and
  **~3h before any guard existed**.
- It was therefore **my own action as the pipeline coordinator, taken before this v2 task began** —
  not an action of the v2 session, and not "executed just now".
- It was write-class (`spawn.sh` runs `orca worktree create` + `orca terminal create`), and it
  **failed**: `orca worktree list` and `terminal list` contain no `93b`, and `task-list` has no `93b`
  task. Nothing was created.
- `logs/exec.log` contains **zero** matches for `spawn.sh|worktree create|terminal create|worker-start|
  dispatch|task-create`, i.e. **no write-class command ever passed through the guard in the v2
  session**. Item 6 (single exit gate) stands; there is no gate bug.

## Process rules (standing)

- **No step closes red.** The suite result must be visible *before* the commit is made, not after.
  Two commits in the B3 run broke this and are recorded rather than hidden:
  `6c21646` (B3 a/b) went in at **25/26** — the `melusine` worktree made a hard-coded worktree count
  fail — and was fixed by the next commit `9aa11d6`; the out-of-scope commit went in at **28/29** and
  was fixed by amending it into `e4b81c5`, which re-verified at **29/29**. Both were committed in the
  same call that ran the tests, with the result cut off by a `tail` that hid the pass/fail line.
- **Cron job scripts are Python, never bash.** Hermes cron dispatches `.sh` job scripts to WSL on this
  host and WSL is not installed — the job failed with `execvpe(/bin/bash) failed: No such file or
  directory`. Both `sup-lessons-review` scripts are `.py` for that reason.
- **A silent `catch` is a defect.** The first version of the out-of-scope loader reported zero rows
  while failing to read the file at all; the loader now reports a read failure loudly.
- **Journals are append-only — a state change is an appended EVENT, not an edit.** This was violated
  once in a B3 simulation (an in-place status flip on `journal/lessons.jsonl`). Fixed by
  `src/journal.js`: effective state is computed from `status_change` / `supersede` events, ids are
  derived (never stored), and the single resolver is shared with the Python cron scripts through
  `node src/journal.js …`. Restoring a journal from a backup is itself a violation — undoing a change
  is another event. See `docs/state-model.md`.

## Next action

**A3 is DONE.** The credential was added by the user (`hermes -p orca-sup auth add opencode-go`), and
both remaining criteria now pass:

```
hermes -p orca-sup auth status opencode-go  -> logged in
hermes -p orca-sup -z "Reply with exactly: hello from orca-sup"  -> "hello from orca-sup"
```

**(e) pin test — ANSWERED: pin does NOT block an agent-side patch.**
Method: created the throwaway skill `orca-sup-pin-test`, `hermes -p orca-sup curator pin` (output:
*"pinned 'orca-sup-pin-test' (recorded; this skill is unmanaged — auto-transitions never consider
it…)"*), then asked the orca-sup agent to patch it with `skill_manage`. Raw tool return:
`{"success": true, "operations_applied": 1, "results": [{"name": "orca-sup-pin-test", "action": "patch", "success": true}]}`
and the agent independently read the file back: line 11 = `PATCHED-BY-AGENT` (501 B). Hash before
`0757181c…` → after `183673aa…`. Sidecar `.usage.json` records `last_patched_at 2026-09-22T13:24:32`.
Throwaway deleted; `hermes -p orca-sup skills list` shows no residue.

**Consequence for B3:** `pin` exempts a skill from curator auto-transitions and LLM passes only. It is
**not** a guard against the agent editing its own rules. The lever that does gate agent-side skill
writes is **`skills.write_approval: true`** (every create/edit/patch/write_file/delete stages for
review), optionally combined with `auxiliary.background_review.enabled: false`.

**Correction to the isolation claim:** the profile is not literally empty — it holds **1** bundled
skill (`autonomous-ai-agents/hermes-agent`, mtime preserved from 2026-09-17) against **116** in the
main profile, and `.bundled_manifest` lists just that one. The create message "No bundled skills
seeded" is therefore not the whole truth. Isolation is still effective; the claim is corrected.

## Pending approvals

- F1 harness experiment — the only step of the whole plan still awaiting approval
- D1's `npm ci` peak — deliberately left unmeasured this pass; to be captured opportunistically during a
  real E2 or live scenario, without asking anyone to free RAM on demand (`docs/d1-capacity.md`)

## Notes for the next session

- `verify-untouched` is the proof tool: `node bin/verify-untouched` → exit 0 = nothing in the
  protected set changed. Run it at the start and end of every step.
- The manifest is **987 files / 57,505,135 bytes** across 6 zones (repo root + proteus-5,
  Hermes config/soul/processes/skills/hooks/kanban, cron jobs file).
- Two bugs were found and fixed while building A0 (both in `src/build-manifest.js`): the
  worktree list was parsed from the text table and silently dropped every worktree except the
  root; and `orca worktree list` returns other repos too, which were filtered out.
- Untouchables are unchanged: `verify-untouched` reports 987/987 UNCHANGED, 0 dynamic diffs.
