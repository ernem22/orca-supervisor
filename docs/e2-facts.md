# E2 — the 12 critical facts

This file exists because the drill's own subject found the flaw in the drill: after the compaction, the
orca-sup session reported that **the approved 12-fact list was never written to disk**, so a post-compaction
"score each" would be unfalsifiable. It was right. This is that list, written after the fact and labelled as
such — the recovery was scored against it, not against a list the session could see.

The drill itself: session `20260925_173720_8aec20` in the `orca-sup` profile, driven from this side over a
PTY. The same question was asked before and after `✅ Compressed: 83 → 47 messages, ~113,532 → ~59,739
tokens`. Full transcript: `evidence/E2/transcript-full.md` (85 messages, 1,531 lines).

| # | fact | source it must be recovered from |
|---|---|---|
| F1 | live Run `run_4e539259ab29` | `orca orchestration run-current --json` |
| F2 | live coordinator handle `term_752a4375-4a0f-449a-84dd-1f87898c0157` | `orca terminal list --json` |
| F3 | sandbox Run `run_2386e733f7ea` | `run-list --json` |
| F4 | sandbox worktree `sup-sandbox-wt6` | `worktree list` / terminal records |
| F5 | v2 repo HEAD | `git rev-parse HEAD` in `D:/code/orca-supervisor` |
| F6 | pipeline repo HEAD | `git rev-parse HEAD` in `proteus-5` |
| F7 | D1's closing answer: `free_slots = 0` at 915 MB available | `src/capacity.js` / `docs/d1-capacity.md` |
| F8 | `npm ci` peak left unmeasured (the open D1 gap) | `docs/d1-capacity.md` / handoff |
| F9 | open incidents: the curator drift (5 CHANGED / 19 NEW) | `bin/verify-untouched` |
| F10 | the high-severity cutover items (9, 11, 12) | `docs/cutover-plan.md` |
| F11 | model-exhausted flag: false | handoff |
| F12 | next action: E2 → E3 | handoff / `PROGRESS.md` |

## Score — scenario 1 (compaction), evidence-based

Checked mechanically against the transcript's post-compaction section, not from memory:

| column | result |
|---|---|
| present in the compaction summary | **yes** — the summary carries a `## Historical Task Snapshot` with the goal and constraints |
| recovered correctly **from source** | **12/12 present**, and every item in the answer names its own source (`run-current`, `terminal list`, `git rev-parse`, `gh`, the journal) |
| fabricated | **0 found** — spot-checks matched: `ace8ca8` was really the HEAD at the time, the handle was the real one, the run ids and task counts matched the live Orca state |

**Acceptance per TASKS.md: 12/12 recovered from source, fabrication 0 → B2 needs no revision.**

## What the drill proved beyond the score

- **The recovery beats the handoff.** The session re-derived facts the handoff never contained: the 15 runs,
  four `reclaimable` sandbox dispatches with their exact ids, and the current PR states — including that
  #126 is MERGEABLE with **no** `dsv-verdict` comment, that #93's three verdicts sit on stale commits, and
  that #92 is CONFLICTING.
- **It applies the runbook's own staleness rule.** It noticed `handoff.md` was 19 seconds older than the
  last journal write and said so, per the protocol, instead of silently trusting it.
- **Rule 2 is what makes this work.** Nothing was answered from memory: every id, handle and SHA was
  re-derived, which is why the numbers are right even though the context they came from was compressed away.

## Honest limits of this score

- The 12-fact list was reconstructed **after** the drill, as noted at the top. The substring check proves
  each fact **appears** post-compaction; it does not prove every one of the twelve was stated **correctly** —
  that was spot-checked on F1, F2, F5 and F7 only.
- **Scenario 2 (close the session, open a fresh one, same re-orientation) has not been run yet.** It is the
  remaining half of E2.
- One compaction, one session, one host. Nothing here generalises beyond that.
