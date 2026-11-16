# Compaction design — lossless enough to be trusted (B2)

Scope: the `orca-sup` profile only. This document is a DESIGN; the lossless criterion is defined by
the E2 drill, not here. No compression setting was changed while writing it.

Evidence levels are marked: **[verified]** = a command's raw output, **[code reading]**,
**[doc claim]**, **[assumption]**.

---

## 1. The settings this profile actually resolves to, and why

**First, is 0.50 ours or Hermes'?** It is Hermes' built-in global default, not something this profile
carries. Evidence: `hermes_cli/config_defaults.py:526-538` defines

```python
"compression": {
    "enabled": True,
    "checkpoint_required": False,
    "progress_notices": False,
    # threshold: compress when context usage exceeds this ratio. Models with windows below 512K
    # are floored at 0.75 (raise-only) so compaction doesn't fire with half the window free; set
    # above 0.75 to override the floor.
    "threshold": 0.50,
```
and the bundled reference agrees: `…/hermes-agent/references/configuration.md:13` —
`| compression | enabled, threshold (0.50), target_ratio (0.20) |` **[verified: code + doc]**. Every
fresh profile without a compression block gets 0.50; the main profile differs only because it was
explicitly tuned to 0.75.

**Does the 512K floor change that here?** No. The floor raises the threshold to 0.75 for models with
windows under 512K; this model's window is **1 048 576** (`deepseek-ai/DeepSeek-V4.1-Flash`,
`models_dev_cache.json` **[verified]**), so the floor does not apply and the effective threshold for
`orca-sup` is **0.50** while the main profile's is **0.75** — a real difference, not an illusion.

Raw output of `hermes -p orca-sup config get compression` **[verified]**:

```
enabled: true
checkpoint_required: false
progress_notices: false
threshold: 0.5
threshold_tokens: null
target_ratio: 0.2
tail_mode: lean
protect_last_n: 20
min_tail_user_messages: 1
max_attempts: 3
proactive_prune_tokens: 0
proactive_prune_min_result_chars: 8000
```
plus `compression.protect_first_n = 3` and `compression.hygiene_max_turn_hold_seconds = 10` **[verified]**,
and three keys the first dump did not show: `in_place: true`, `idle_compact_after_seconds: 0`,
`model_thresholds: {}`, `codex_responses_compact_threshold: null` **[verified]**. `in_place: true` is
the important one: compaction rewrites the same session id rather than rotating it, which is exactly
the `in_place` flag the `session:compress` hook reports — so the hook can tell the two cases apart.

Why these values, and why they are not being changed:

| Setting | Value | Why it has that value | Verdict |
|---|---|---|---|
| `threshold` | **0.50** | the profile's **default**; the main profile runs 0.75 because it was tuned there. The profile has no override. | **Left alone.** Lowering it would compact more often; raising it without measuring the profile's real context growth would be a guess. The main profile's 0.75 is *evidence about a different workload* (a coordinator reading a 107 KB contract), not about this control plane. Change it only with a measurement, and only after E2. |
| `target_ratio` | 0.20 | default; the summary targets 20% of the pre-compaction size | left alone |
| `protect_last_n` | 20 | default; **20 messages** kept verbatim at the tail | see §3 |
| `protect_first_n` | 3 | default; the first ~3 non-system messages pinned | see §3 |
| `min_tail_user_messages` | 1 | default; at least one user message survives | keep — it is what keeps the *instruction* alive |
| `tail_mode` | lean | default | left alone |
| `checkpoint_required` | false | default. `true` demands a truthful pre-compaction checkpoint and **fails closed** on `codex_app_server` (`BLOCKED_MISSING_PREREQUISITE`) **[code reading: agent/agent_init.py:321-337]**. Our `api_mode` is `chat_completions`, so it is *compatible*. | **Candidate to flip to `true`** — that is exactly the guarantee this design wants. Deferred: flipping it is a settings change and belongs to the step where the checkpoint path is proven (E2). |
| `progress_notices` | false | default; the main profile sets true | **Flip to `true`** when the supervisor goes live: a compaction the operator never saw is the failure mode this whole design exists to prevent. |
| `hygiene_max_turn_hold_seconds` | 10 | gateway session hygiene, a safety net whose threshold (0.85) sits above the agent compressor's (0.50) **[code reading: gateway/run_turn.py:585-595]** | left alone |
| `max_attempts` | 3 | default | left alone |

## 2. Strategy: checkpoint first, compact second

The rule: **never compact over a stale checkpoint.** A compaction is a stage boundary, like handling a
settlement or before a dispatch wave.

Two paths, in preference order:

**(a) Hook-driven — available, but POST.** Hermes supports a `session:compress` gateway event that
fires when "context compression completed for a session", carrying `platform`, `session_id`,
`old_session_id`, `in_place`, `compression_count` **[doc claim]**. There is **no pre-compaction
event** in the supported list, so the hook cannot *write* the checkpoint before the fact — it can only
**verify** it after: the handler reads `handoff.md` and the last journal records and alerts if the
checkpoint is older than the compaction, or if `compression_count` advanced without a checkpoint
between. That is the honest use of the hook, and it is what §6 installs later.

**(b) Supervisor discipline — the primary path.** At every stage boundary the supervisor writes the
checkpoint, then compacts:

```
1. node src/checkpoint.js show          # what does the current handoff/journal say?
2. write handoff.md  (<= 2048 B, four headings) and append any new decision to the journal
3. only then request /compact
```
If the context nears the threshold between stage boundaries, the supervisor does not compact on its
own: it writes an inbox item of kind `compact-ok` (D3's schema) and lets the coordinator decide. The
inbox item carries the checkpoint path and the byte size, so the decision is one glance.

**(c) Optional hard gate — a shell hook.** Hermes shell hooks can **block** (exit code 2, Claude
Code/Cursor compatible) **[doc claim]**. A `pre_tool_call` hook that refuses the compaction when
`handoff.md` is missing or older than the last journal write turns the discipline into an
enforcement. Design only; installing it needs approval (it is a config write).

## 3. What is guaranteed to survive, and what is not

- **Kept verbatim:** the last `protect_last_n = 20` messages, and the first `protect_first_n = 3`
  non-system messages (plus a small probe allowance) **[code reading: agent/context_compressor.py:2297,2320,2884,3912-3915]**. These are **message counts, not tokens**.
- **Summarized:** everything between them.
- **Therefore:** anything a future turn depends on must be either in the protected window or in the
  checkpoint. Nothing may rely on the summary carrying it.

This is the load-bearing sentence of the whole design, and it is why §5 exists.

## 4. Post-compaction re-orientation protocol

On the first turn after any compaction notice, in this order, and never from memory:

1. `handoff.md` — where I was, what is next, what I am waiting on, what could go wrong.
2. `journal/decisions.jsonl`, last N records — what was decided, by whom, and what is still open.
3. A fresh snapshot from Orca + GitHub (class A) — the current truth.
4. Only then act.

**Never trusted from memory:** dispatch ids, terminal handles, commit SHAs, task statuses, PR states,
"a watcher is running". A remembered value may be right; it is not evidence. This session's own record
is the argument: after a compaction the coordinator believed a watcher was alive and it had been dead
for twenty hours, and a `worker-list` page that silently dropped rows was trusted over
`counts.retained`.

## 5. Fields that MUST appear in the compaction summary

Hermes exposes **no configurable summarization instruction** for compression **[verified: the resolved
compression block has no prompt/instruction key]**. So the fallback the step describes applies: the
fields live in the **handoff**, not in a prompt, and the handoff is the first thing read after a
compaction. The handoff's four headings carry them:

| Field | Where it lives | Why it must survive |
|---|---|---|
| run id + coordinator binding | re-derived (class A) | never stored — `run-current` answers it |
| active dispatch ids | re-derived (class A) | never stored — `task-list`/`worker-list` answer it |
| pending decision / open question | `journal` (`kind: question`) + `handoff ## Waiting on` | nothing can re-derive a question that was never answered |
| the user's current focus instruction | `journal` (`kind: focus`) + `handoff ## Now` | the one thing a summary reliably mangles |
| deliberate deviations and their reasons | `journal` (`kind: deviation`) | a rule broken without the reason looks like a mistake |
| standing preferences (model, tester serialisation, human-merge) | `journal` (`kind: preference`) | cheap to lose, expensive to re-learn |
| next action + the command that starts it | `handoff ## Next` | the difference between resuming and re-planning |
| open risks + their early signal | `handoff ## Risks` | the signal is useless if it is discovered late |
| latest head SHAs, PR/verdict state | re-derived (class A) | storing them is what caused two wrong merges |

## 6. What this design does NOT do

**The checkpoint-first discipline is currently UNENFORCED by any mechanism.** This is the design's
central open risk, stated plainly: no pre-compaction hook exists that could *write* a checkpoint, and
`session:compress` fires only *after* compaction completes — it can verify a checkpoint, never create
one. So between the moment context nears the threshold and the moment compaction runs, the guarantee
rests on **the coordinator remembering**, and on nothing else. A compaction that happens without a
fresh checkpoint is silent: the summary replaces the messages, and nothing raises an error.

What would change that, none of it installed today:
- the optional `pre_tool_call` shell hook in §2(c), which can **block** (exit code 2) a compaction
  whose checkpoint is stale — this is the only mechanism that converts discipline into enforcement;
- `checkpoint_required: true`, which fails closed before lossy compaction (compatible with our
  `chat_completions` mode) — but note its own comment: it is designed around *an active memory
  provider confirming checkpoint API compatibility*, so it may not do what we want without one
  **[code reading: config_defaults.py:528-530]**;
- `progress_notices: true`, which at least makes a compaction visible instead of silent.

Also not done here: the threshold, `target_ratio` and the protect windows are unchanged — those need
the E2 measurement, not an opinion.

## 7. Open items handed to E2

1. **The compliant scenario.** Score the 12 facts after a real `/compact` in `orca-sup`, recovered
   only through the §4 protocol, and again after closing and reopening a session.
2. **The `checkpoint-skipped` scenario — measure what happens when the coordinator forgets.** Run the
   same drill with a deliberately stale (or absent) checkpoint: compact anyway, then attempt the
   re-orientation. Score: which facts are unrecoverable, whether the supervisor notices it is
   operating on a stale handoff, and whether any fabrication appears. This scenario is the one that
   decides whether §6's open risk is acceptable, so it is an acceptance case, not a footnote.
3. Decide `checkpoint_required: true` and the `pre_tool_call` gate on the basis of those two
   scenarios, not before them.
4. Flip `progress_notices: true` when the supervisor goes live.
5. Measure whether threshold 0.50 is right for this profile's actual context growth (the main
   profile's 0.75 is evidence about a different workload).
