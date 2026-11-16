# State model — what v2 stores, and what it refuses to store

B1 deliverable. The problem it solves: a supervisor whose memory is a copy of pipeline state goes
wrong the moment the pipeline moves without it. Everything below follows from one rule:

> **If Orca or GitHub can answer it, v2 does not remember it. It asks.**

Nothing here is connected to Hermes yet (B1's own boundary). This is the design plus the code that
enforces its shape.

---

## Class A — re-derivable state: NEVER copied

Re-derivable means: a command returns the current truth, cheaply, without side effects.

| State | Where the truth lives | Read with |
|---|---|---|
| Task status, task list | Orca | `orca orchestration task-list --json` |
| Dispatch state, launch method, liveness, attention, nextAction | Orca | `worker-list --json`, `dispatch-show --task <id>` |
| Terminal inventory and agent identity | Orca | `terminal list --json` |
| Worktrees (registered) | Orca | `worktree list --json` |
| Run identity, coordinator binding | Orca | `run-list`, `run-current` |
| PR head, checks, mergeable, base, verdict comments | GitHub | `gh pr view/checks`, `gh api …/status` |
| Issue state and labels | GitHub | `gh issue view/list` |
| The pipeline's own tooling and docs | git | `git log`, `git status` |

**Prohibited in this class:** caching any of the above into a file, remembering a dispatch id, a
handle, a SHA, or a task status across a stage boundary, or writing pipeline state into the journal.

Why: this session produced two concrete failures of the copied-state pattern — a `worker-list` page
that silently dropped rows (`counts.retained 151` vs 100 returned), and a task that moved
`dispatched → ready` on Orca's own supervision while a stale copy still said "live". A copy is a
claim about the past dressed as a fact about now.

**Allowed instead:** store the *query* and a timestamp, never the value. `handoff.md` may say
"re-derive: open PRs and their verdict state" but not "PR #93 is mergeable".

## Class B — decisions and intent: the journal

What is NOT re-derivable: what a human or the coordinator *decided*, and why. That is the only thing
worth persisting, because no command can reproduce it.

`journal/decisions.jsonl` — append-only, one JSON object per line:

```
{ "ts": "<ISO-8601 UTC>", "kind": "<see below>", "content": "<one sentence>",
  "source": "user" | "self", "related": { "pr": <n?>, "issue": <n?>, "task": "<id?>" } }
```

`kind` is one of: `focus` (what we are working on and why), `preference` (a standing choice, e.g.
human-merge, tester serialisation), `question` (asked and not yet answered), `deviation`
(deliberately departing from a rule, with the reason), `approval` (a gate the user opened or closed).

Rules:
- **Pipeline state is NOT written here.** No task statuses, no "dispatch x is running", no PR heads.
  If a line describes where the pipeline *is* rather than what someone *chose*, it belongs in class A.
- Append-only: never edit or delete a line. A decision that is later reversed is recorded as a new
  line that supersedes it, so the trail keeps both.
- One sentence per line, hard cap 1024 bytes (enforced by `src/checkpoint.js`).
- `source: user` lines are the user's instructions, quoted as close to verbatim as the one-sentence
  cap allows; `source: self` lines are coordinator decisions.

### The append-only rule is load-bearing, and it applies to every journal

This rule was violated once: a B3 simulation moved a lesson from `proposed` to `accepted` with an
in-place edit of `journal/lessons.jsonl`. The result looked correct and was wrong — it destroyed the
history the file exists to keep, and it made "append-only" a comment rather than a property. It is
now a contract, and it covers `lessons.jsonl` exactly as it covers `decisions.jsonl`.

**A state change is an appended event, never an edit.**

```
lessons:   { "type": "status_change", "lesson_id": "L…", "from": "proposed",
             "to": "accepted", "time": "<ISO-8601 UTC>", "actor": "<who>" }
decisions: { "type": "supersede", "decision_id": "D…", "actor": "<who>", "time": "<ISO-8601 UTC>",
             "reason": "<one sentence>" }
```

- **Effective state is computed, not stored.** A lesson's status is the `to` of the most recent
  `status_change` for its id; if no event exists, it is the record's own `status` field, which is a
  *seed value* and not the current one. A decision is superseded iff a `supersede` event names it.
  Undoing a change is another event, never a rewrite — restoring a journal from a backup is itself a
  violation.
- **Ids are derived, never stored.** `L`/`D` + the first 12 hex of sha256 over the record's symptom
  (lessons) or content (decisions). Storing an id would require editing the record to add it.
- **One implementation.** `src/journal.js` is the only resolver, and it exposes
  `node src/journal.js count-proposed | list | status <id> | append <json>` so the Python cron scripts
  use the same logic rather than reimplementing it. `src/b3-proposal-dryrun.js` and the
  `sup-lessons-review` monitor both read through it; reading a record's `status` field directly is a
  defect, because that field is history.
- **The file is never rewritten.** The only writer is `appendEvent`, which refuses to append when the
  file does not end in a newline (that would fuse two records) and re-parses the whole file after
  writing, reporting any malformed line instead of assuming success.

## Class C — ephemeral: disposable

The mailbox queue, terminal screens, in-flight tool output, token counters, port bindings. Nothing in
this class is written anywhere. If a process dies, class C dies with it and nothing of value is lost;
if something in class C turns out to matter, it was a decision (class B) or a fact (class A) and was
misfiled.

---

## `handoff.md` — at most 2048 bytes

Four headings, nothing else. Rewritten at stage boundaries (a settlement handled, before a dispatch
wave), never appended.

```
## Now
What is in flight, in one or two lines, phrased as intent.

## Next
The single next action, and the command that starts it.

## Waiting on
What is blocked and on whom (a human decision, a gate, a worker).

## Risks
What could go wrong next, and the early signal that would show it.
```

The size cap is the point: a handoff that grows into a status report is a handoff nobody reads after
a compaction. If it does not fit, the content belongs in the journal (class B) or in a query (class A).

## Re-orientation after compaction (the protocol this model exists for)

In this order, and never from memory:

1. `handoff.md` — where I was and what I was doing.
2. `journal/decisions.jsonl` — the last N lines: what was decided, by whom, and what is still open.
3. A fresh snapshot from Orca + GitHub — the current truth of class A.
4. Only then act.

A remembered dispatch id, handle, SHA or task status is treated as absent. It may be right; it is not
evidence. This session's own record is the argument: after a compaction the coordinator believed a
watcher was running, and it had been dead for twenty hours.

## Enforcement

`src/checkpoint.js` is the only writer of `journal/decisions.jsonl` and `handoff.md`. It validates the
decision schema, refuses oversized content, writes atomically (temp file + rename, so a crash leaves
the old file intact rather than a half-written one), and refuses to append a line that looks like
class A state (a guard against the most likely misfiling: task/dispatch status creeping in).

Tests: `tests/checkpoint.test.js`.
