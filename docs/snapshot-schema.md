# Snapshot schema (C1)

`src/snapshot.js` produces one JSON document per call. It is **read-only**: every command goes through
`src/guard/exec.js`, and the guard's allow list is the only reason a command runs at all. A snapshot
never deletes, closes, aborts or reaps anything — classification and decisions are C2/C3's job.

Two rules that shape everything below:

1. **No class-A copying.** A snapshot is a *dated observation*, not a source of truth. It records what
   a command returned at a moment; it never becomes the thing a later decision reads as current.
2. **Masking is mandatory in fixtures.** Any token, key, cookie or credential that appears in command
   output is replaced by `<masked:kind:len>` before it is written. Live snapshots are written to
   `state/snapshots/`; fixtures live under `tests/fixtures/snapshot/` and are always masked.

## Top level

```
{
  "schema": "snapshot/1",
  "taken_at_utc": "<ISO-8601 Z>",
  "taken_by": "src/snapshot.js",
  "read_only": true,
  "errors": [ { "step": "<name>", "command": "<argv>", "error": "<message>" } ],
  "orca":   { ... },     // section 1
  "github": { ... },     // section 2
  "host":   { ... },     // section 3
  "derived":{ ... }      // section 4 — computed, never a new fact
}
```

A failed step never aborts the snapshot: it is recorded in `errors[]` and the run continues. A
snapshot that silently omitted a section would be worse than one that says it could not read it.

## 1. `orca`

| field | source | notes |
|---|---|---|
| `version` | `orca --version` | string |
| `run` | `orca orchestration run-current --json` | `run_id`, `coordinator_handle` |
| `tasks[]` | `orca orchestration task-list --json` | `{id, title, status, created_at}` — the whole set, no pagination |
| `dispatches[]` | `orca orchestration dispatch-show --task <id>` for every `dispatched` task | `{task_id, dispatch_id, assignee_handle, liveness, attention, next_action, resource_state}` |
| `worker_pages` | `orca orchestration worker-list --run <run> --json` (+`--cursor`) | `{pages, rows, counts_retained, truncated}` — pages are followed while `page.hasMore` |
| `terminals[]` | `orca terminal list --json` | `{handle, agent, state, retained}` |
| `worktrees[]` | `orca worktree list --json` | `{path, branch, display_name}` — **registered** trees only |

`liveness` / `attention` / `next_action` come from the `projection` block, which is the reason this
layer exists: it replaces screen-scraping for the liveness question.

## 2. `github`

| field | source | notes |
|---|---|---|
| `prs[]` | `gh pr list --state open --json …` | `{number, title, head_sha, base, mergeable, checks_state, verdict_comment}` |
| `issues[]` | `gh issue list --state open --json …` | `{number, title, labels}` — the `agent` and `human-merge` labels are what C3 reads |
| `verdict_comment` | `gh pr view <n> --json comments` | boolean: a `dsv-verdict` marker on the same line as its opening fence |

The gate reads the **PR's own head SHA**, so `head_sha` is recorded per PR rather than per branch.

## 3. `host`

| field | source | notes |
|---|---|---|
| `disk` | `df -h` | free bytes on `C:` and `D:` |
| `ram` | `powershell Get-CimInstance Win32_OperatingSystem` | total/free MB |
| `processes` | `powershell Get-CimInstance Win32_Process -Filter "Name='node.exe'"` | `{pid, working_set_mb, command_line_masked}` |
| `listeners` | `netstat -ano` filtered to 4173–4221 | `{port, pid, state}` |
| `orphan_dirs[]` | disk worktree directories **minus** `orca.worktrees` | `{path, size_bytes, registered: false}` |

`orphan_dirs` is a set difference, not a heuristic: a directory under the workspace root that Orca does
not list as a worktree. Size comes from `du -sk`. This is a **list**, never a delete.

## 4. `derived`

Computed from the sections above, never independently observed:

- `task_terminal_pr_table[]` — one row per dispatched task: task id ↔ assignee handle ↔ terminal ↔ the
  PR whose branch matches the task's worktree. The fixer #93 case is the worked example.
- `orphan_dirs` — lifted from `host` for convenience, with the same values.
- `notes[]` — plain-language caveats, e.g. "worker-list page 2 unread (cursor rejected)" or
  "verdict check skipped for 3 PRs (rate limit)". A caveat belongs here, not in silence.

## Exit codes

`0` snapshot written · `1` written with `errors[]` non-empty · `2` could not write (no state dir, disk
full). The caller distinguishes "clean" from "partial" without parsing prose.
