# Where things live, and how to get each one back

Written 2026-09-28 after an accidental Orca worktree close deleted `hermit` outright (its directory
was gone; the trash directory was empty) and silently unregistered `proteus-5`, whose directory
survived. Everything below was measured on that day.

## What lives where

| What | Where it lives now | Second copy |
|---|---|---|
| Supervisor code, tests, docs, journals | `D:/code/orca-supervisor` (branch `master`, **no remote**) | none |
| Protected-set baselines + drift tooling | same repo: `manifest/`, `bin/verify-untouched`, `src/build-manifest.js` | none |
| Rescue copy of proteus-5's uncommitted work | `evidence/proteus-5-rescue/` (untracked, 21 files / 102,712 B) | the live directory on C: — 10/10 hashes match |
| Pending-review records | `evidence/pending-review/` (29 files / 192,633 B; 26 tracked) | the profile's `pending/` store, partially |
| Skill snapshots / old config copies | `backups/` (3,010 files / 32.2 MB; 2,020 tracked) | repo history (same disk) |
| Identity-rewrite artefacts (pre-rewrite repo snapshots + scripts) | `backups/identity-rewrite/` (332 files / 11,753,372 B) **and** the Temp originals | yes — two copies, one still in Temp |
| Commits that exist in no remote (see below) | `backups/local-only-commits.bundle` (24,936 B) | only D:/code/design-system-viewer/.git |
| Profile `orca-sup`: 10 authored skills + 1 bundled | `C:/Users/user/AppData/Local/hermes/profiles/orca-sup/skills/` | **none canonical** (see "Recover") |
| Profile identity, memory, config | same profile dir: `SOUL.md`, `memories/MEMORY.md`, `memories/USER.md`, `config.yaml`, `.env`, `auth.json`, `state.db` | none; config/.env/auth are never copied anywhere |
| The product repo + its worktrees | `D:/code/design-system-viewer` (remote: `github.com/ernem22/design-system-viewer.git`) | remote for pushed refs only |
| Archived skill copies | `backups/skills/` (8 skills, timestamps) | one stale `orca-sup-reference` only |

The 10 authored profile skills, by name: `hermes-session-forensics`, `git-worktree-state-forensics`,
`hermes-write-approval-review`, `host-process-attribution`, `host-resource-gating`,
`orca-state-probing`, `orca-sup-reference`, `orca-sup-runbook`, `orca-sup-state-writes`,
`pipeline-guardrail-finding`. The 11th, `autonomous-ai-agents/hermes-agent`, is bundled and
re-installable (`.bundled_manifest`), so it is not a copy worth keeping.

## How to recover each

* **Supervisor repo, whole thing** — currently there is no remote, so recovery means *this disk*. That
  is the single biggest exposure in this file; step 4 (private remote) exists to close it.
* **Commits that exist only locally** — `backups/local-only-commits.bundle`
  (sha256 `824863b31cd0fe6f4214aa5ad783e44f1ad94a4d52d5153dd37a625cd3970ff5`, 24,936 B) carries four
  branches and exactly six commits: `a962fe1`, `6190358`, `d7eff4f` (branch `ernem22/hermit`, no
  upstream, 3 unique commits), `746beff` (`refactor/full-react-migration`), `7831121`
  (`fix/shell-onto-pipeline-base`), `a93326b` (`main`). To recover into an existing clone:
  ```bash
  git bundle verify backups/local-only-commits.bundle          # needs the prerequisites present
  git fetch backups/local-only-commits.bundle '+refs/heads/*:refs/heads/restored/*'
  ```
  The bundle declares four prerequisite commits, so it must be fetched into a clone that already has
  the remote-tracking refs (verified: the six commits are absent before the fetch and present after).
* **proteus-5's uncommitted work** — `evidence/proteus-5-rescue/` holds all 10 files with matching
  sha256 pairs (`hashes.txt`); re-verify with the recorded hashes rather than trusting the copy.
* **Identity-rewrite artefacts** — `backups/identity-rewrite/` mirrors the Temp directory
  byte-for-byte (332/332, sha256 of `ds-backup.bundle` = `929310127f8f5e79…` on both sides); the
  table is `backups/identity-rewrite-VERIFICATION.txt`. The Temp originals still exist.
* **Profile skills and memory** — no canonical second copy exists. `SOUL.md`, both memory files and
  the 10 skills total 82,726 B across 22 files, so exporting them into the repo is cheap and is
  proposed (not executed) in `evidence/step4-push-prep/README.md`. The bundled skill needs no copy.
* **A worktree about to be closed** — run `scripts/safe-close-check.sh <worktree-path>` first. It is
  read-only and refuses (exit 1) on uncommitted work, on commits reachable from no remote-tracking
  branch, on a missing upstream and on a detached HEAD.

## The three rules

1. **A worktree is clean and pushed before it is closed.** Closing is not reversible: the close path
   keeps no archive, and the trash directory can be empty. `scripts/safe-close-check.sh` is the gate
   that says so before the fact.
2. **No long-lived uncommitted work.** Work that matters gets committed and pushed, or copied out of
   the disposable place it lives in. If it is worth keeping, it is worth a second location that is
   not the same disk.
3. **Agents start from a stable directory.** Work happens in `D:/code/orca-supervisor`, never from
   inside a worktree that another process may close. A directory that can vanish under you is not a
   working directory.

## What is deliberately left alone

`proteus-5` stays untouched and unregistered in Orca (a second copy until its files are reviewed);
`hermit`'s zone stays in the protected manifest until a journaled retirement event exists;
`git worktree prune` has not been run and no branch has been deleted.
