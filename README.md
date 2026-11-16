# orca-supervisor

A guarded supervisor for unattended multi-agent development runs. It watches the agents that a dispatcher starts (coder, fixer, reviewer, tester), classifies what each one is doing, and can nudge, reap, or abandon stalled work. Every action goes through a guard layer and is journaled.

This is a working personal project, built and run on one Windows machine alongside the [Orca](https://github.com/ernem22/orca) workspace manager and Hermes agent profiles. The dispatcher that starts the agents lives in [design-system-viewer](https://github.com/ernem22/design-system-viewer) (`tools/orchestration/`, `ORCHESTRATION.md`).

## What is in here

| Path | Purpose |
|---|---|
| `src/snapshot.js`, `src/classify.js` | Take a snapshot of terminals, workers, and worktrees, then classify each agent's state |
| `src/actions/` | `nudge`, `reap`, `abandon`, `spawn`, all built on a shared core |
| `src/guard/exec.js` | The only process-starting module; every command is checked against scope rules first |
| `src/journal.js`, `src/capacity.js` | Decision and lesson journal, and capacity limits per role |
| `src/build-manifest.js`, `bin/verify-untouched` | Protected-zone manifest and a check that the supervisor never touched protected work |
| `src/shadow*.js` | Shadow mode: observe and report without acting |
| `scripts/safe-close-check.sh` | Read-only gate that says whether a worktree is safe to close |
| `scripts/secret-scan-history.py` | Scans every blob in git history for credential patterns, with masked output |
| `templates/` | Prompt templates for the four agent roles |
| `docs/` | State model, decision table, snapshot schema, pruning and compaction designs, cutover plan |

## Status and limits

- Research and operations tooling, not a packaged product. There is no install step; scripts are run with Node 22 and Python 3.
- It was written against one Windows host. Hard-coded paths such as `D:/code/orca-supervisor` and `C:/Users/user/...` were kept (the user name was anonymised) and need adjusting.
- Many tests read local runtime state (`state/`, `logs/`, `manifest/`) that is not published here, and they fail without it. A clean checkout does not give a green run. I have not claimed a pass count.
- `PROGRESS.md` and `docs/TASKS.md` are the original working notes, kept unedited apart from the user-name replacement.
- Git history was not published. This repository is a single snapshot of the source, tests, and docs.
