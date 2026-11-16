# Profile memory proposal for `orca-sup` (B3 e — LIST ONLY, nothing written)

Nothing here has been written to memory. This is the list for approval, with the budget it would
consume. Memory is injected into **every** turn, so the bar for an entry is high: it must be true in
every session, and it must be a fact rather than an instruction to myself.

Budget: `MEMORY.md` 2200 chars, `USER.md` 1375 chars — the same shape the default profile uses.

---

## A. `MEMORY.md` — environment and conventions (measured: **1 768** / 2200 chars, 10 entries)

*The first draft of this header said "~1 480". The measurement says 1 768, so the estimate was wrong
and is corrected here rather than quietly replaced. 80% of the budget for ten entries is workable but
tight: entries 4 and 10 are the two longest and the two most compressible if the budget bites.*

1. The control plane lives in `D:/code/orca-supervisor` and writes only inside it, plus this
   profile's `pending/` and `hooks/`. Product code is never edited from here.
2. Only `src/guard/exec.js` may start a process; every other path routes through it and is recorded
   in `logs/actions.log`. A new spawn site outside the guard is a defect, not a shortcut.
3. `bin/verify-untouched` exits 0 clean, 1 on a diff, 2 with no manifest. Only static content may
   fail it — git HEADs, PR lists and Orca counts are informational by design.
4. Orca's `--json` projections replace screen-scraping: `projection.liveness` (live/unverifiable/
   exited), `attention.requiresAction`, and `nextAction.argv`. `worker-list` pages newest-first at
   100 rows; `counts.retained` is the true total, so a short array means dropped rows.
5. Never trust a remembered dispatch id, handle, SHA or branch — re-derive it from Orca or GitHub
   every turn. State is re-derived, never recalled.
6. A verdict exists only as a `dsv-verdict` PR comment on the same line as the opening fence; the
   gate does not read messages, and `worker_done` is a notification, not a verdict.
7. Host limits: ~7.5 GB RAM, C: is the binding constraint, browser-driving testers are serialised,
   and 3–4 concurrent workers is the practical ceiling.
8. In this shell `taskkill //F //PID` no-ops; the measured-working form is `taskkill -F -PID`, and a
   kill is verified by the port, never by the exit code.
9. Hermes cron on this host dispatches `.sh` job scripts to WSL, which is not installed — job scripts
   must be Python. `.sh` fails with `execvpe(/bin/bash) failed`.
10. The profile's `hooks:` config is a dict keyed by event name, and the command is executed without a
    shell: a bash hook needs an absolute, quoted interpreter path (`"C:/Program Files/Git/bin/bash.exe"`).

## B. `USER.md` — who the user is (measured: **682** / 1375 chars, 5 entries)

1. Writes Turkish, informal and terse ("kanka", "hocam"); expects the same in chat, while artefacts —
   docs, specs, commits, PR bodies — stay in English.
2. Wants only verified findings turned into work; an unreproduced finding is reported as unverified
   rather than filed, and a wrong number is corrected in the open instead of quietly edited.
3. Prioritises progress over polish: finished work is closed immediately, and waiting to be poked is
   treated as a defect in the supervisor.
4. Prefers user-felt bugs over cosmetic ones, and real throughput — parallel workers by default, not
   a serialised pipeline.
5. Reads reports as evidence: accept/verified/reject labels and raw output, not prose padding.

---

## What I deliberately left out

- Anything that belongs in a skill rather than memory (the loop, the hard rules, the file map) — that
  is what `orca-sup-runbook` is for, and duplicating it here would pay for it twice on every turn.
- Anything already derivable in one command (`PROGRESS.md`, `git log`, `verify-untouched` output).
- Anything that is task state rather than a standing fact: the current step, the open approvals, the
  list of live workers. Those change hourly and would go stale inside the budget.
