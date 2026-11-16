#!/usr/bin/env bash
# scripts/safe-close-check.sh -- the pre-close gate for a worktree.
#
# WHY THIS EXISTS
#   A worktree was closed by accident and its directory was deleted outright: the trash directory
#   that the close path creates was empty, and the worktree's own git registration was gone. Its
#   uncommitted work was not recoverable; only the commits that had reached a branch survived.
#   Closing a worktree is therefore not a reversible operation, and this script exists to answer
#   exactly one question before it happens: is it safe to close THIS worktree right now?
#
# WHAT IT IS
#   Stateless and READ-ONLY. It runs no command that writes to the repository: every git call is
#   made with --no-optional-locks so even the index stat-cache is left alone, and it prints what it
#   found instead of changing anything. It has no configuration, keeps no state, and is not wired
#   into any live path -- it is invoked by hand or by a future gate that decides to call it.
#
# USAGE
#   scripts/safe-close-check.sh <worktree-path>
#
# EXIT
#   0  safe to close: clean tree, branch pushed, upstream configured
#   1  NOT safe: at least one reason printed below
#   2  usage error, or the path is not a git working tree (nothing was inspected)
#
# The three reasons it refuses on, each of which was a real failure mode:
#   * `git status --porcelain` is not empty -- uncommitted work has no other copy.
#     `.hermes-tmp.*` entries are listed separately because they are scratch, not work.
#   * the current branch has commits not reachable from any remote-tracking branch
#     (`git log <branch> --not --remotes`) -- unpushed commits live only in this clone.
#   * the branch has no upstream -- nothing is tracking it, so nothing will warn you later.
set -u

usage() {
  echo "usage: safe-close-check.sh <worktree-path>"
}

if [ "$#" -ne 1 ]; then
  usage
  exit 2
fi

WT="$1"
problems=0

reason() {
  printf '  REFUSE  %s\n' "$1"
  problems=1
}

printf 'safe-close-check: %s\n' "$WT"

if [ ! -d "$WT" ]; then
  printf '  ERROR   path does not exist or is not a directory: %s\n' "$WT"
  exit 2
fi

# --no-optional-locks on every call: read-only means the index is not refreshed either.
if ! git --no-optional-locks -C "$WT" rev-parse --git-dir >/dev/null 2>&1; then
  printf '  ERROR   not a git working tree: %s\n' "$WT"
  exit 2
fi

status_out="$(git --no-optional-locks -C "$WT" status --porcelain 2>/dev/null)"

if [ -n "$status_out" ]; then
  scratch_lines="$(printf '%s\n' "$status_out" | grep -F '.hermes-tmp.' || true)"
  real_lines="$(printf '%s\n' "$status_out" | grep -vF '.hermes-tmp.' || true)"

  if [ -n "$real_lines" ]; then
    n_real="$(printf '%s\n' "$real_lines" | grep -c .)"
    reason "uncommitted work: $n_real entry/entries in git status --porcelain"
    printf '%s\n' "$real_lines" | sed 's/^/          /'
  fi

  if [ -n "$scratch_lines" ]; then
    n_scratch="$(printf '%s\n' "$scratch_lines" | grep -c .)"
    if [ -z "$real_lines" ]; then
      reason "status is not empty: $n_scratch .hermes-tmp.* scratch dir(s) only"
    else
      printf '  note    %s .hermes-tmp.* scratch dir(s), listed separately (disposable)\n' "$n_scratch"
    fi
    printf '%s\n' "$scratch_lines" | sed 's/^/          /'
  fi
fi

branch="$(git --no-optional-locks -C "$WT" rev-parse --abbrev-ref HEAD 2>/dev/null)"

if [ "$branch" = "HEAD" ]; then
  reason "detached HEAD: no branch points at this checkout, so closing loses the only pointer"
  branch=""
fi

if [ -n "$branch" ]; then
  if upstream="$(git --no-optional-locks -C "$WT" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"; then
    printf '  ok      branch %s tracks %s\n' "$branch" "$upstream"
  else
    reason "no upstream configured for branch $branch"
  fi

  unpushed="$(git --no-optional-locks -C "$WT" log "$branch" --not --remotes --oneline 2>/dev/null)"
  if [ -n "$unpushed" ]; then
    n_unpushed="$(printf '%s\n' "$unpushed" | grep -c .)"
    reason "$n_unpushed commit(s) not reachable from any remote-tracking branch"
    printf '%s\n' "$unpushed" | sed 's/^/          /'
  fi
fi

if [ "$problems" -eq 0 ]; then
  printf '  SAFE    clean tree, branch pushed, upstream configured\n'
  exit 0
fi

printf '  NOT SAFE TO CLOSE: %s\n' "$WT"
exit 1
