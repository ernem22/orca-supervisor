# Pruning and distillation design for `orca-sup-*` skills (B3 d — DESIGN ONLY)

Status: **not installed.** No cron job exists for this, and nothing in this document has been run
against a live skill. It is the proposal the coordinator asked for, to be approved or amended first.

Scope: the two skills this profile owns — `orca-sup-runbook` (resident) and `orca-sup-reference`
(on-demand). Nothing else in the profile is in scope: not bundled skills, not another profile's
skills, and not the live pipeline skill in the default profile.

## 1. What problem this solves

The runbook is capped at 8 KB and is resident: every session pays for every line of it, and after a
compaction it is one of the few things guaranteed to be re-read. Left alone it will grow by accretion
— each new lesson appended as another hard rule — until it is a document nobody reads. The reference
has the opposite failure: it is loaded on demand, so it rots silently when commands change.

Pruning is therefore not tidiness. It is the mechanism that keeps the resident surface small enough
to be read on every turn, and the on-demand surface accurate enough to be trusted.

## 2. The invariant this design must never break

**`orca-sup-runbook` is excluded from automatic distillation.** It is pinned, and pinning is recorded
in the curator ledger. The reason is measured, not assumed: pinning does **not** stop an agent-side
`skill_manage` patch (proven in B3), and `skills.write_approval: true` is what turns any write into a
staged proposal. So a distillation pass may *propose* a runbook change, and that proposal lands in
`pending/skills/` for a human — it can never land in the file on its own.

The reference has no such exemption, because nothing in it is a rule. It is facts about commands, and
facts can be re-derived.

## 3. The pass, in order

Every step is bounded and every step is reversible. The pass refuses to continue if any step's
precondition fails.

1. **Snapshot first, unconditionally.** Copy the current contents of every in-scope skill to
   `D:/code/orca-supervisor/backups/skills/<UTC timestamp>/` — the same location `verify-untouched`
   already uses when a skill row changes — then `git add` + commit that snapshot in the v2 repo.
   Nothing may be deleted before its bytes are in git. This is the "backs up to v2 git before
   deleting" requirement, and it is step 1 rather than a recovery step.
2. **Dry run, always, and it is the default.** The pass computes what it *would* change and writes
   `proposals/prune-<date>.md` describing each candidate: the skill, the section, why it is a
   candidate (duplicate / stale command / unreferenced / oversized), and the exact diff. It writes no
   skill. A dry run is the only mode the first pass ever runs in.
3. **Classification, so deletion is not the only verb.** Each candidate gets one of:
   - **drop** — text that is duplicated elsewhere or describes a mechanism that no longer exists;
   - **distil** — several lines that compress to one rule without losing the trigger;
   - **demote** — content that is useful but not needed every turn: move it from the runbook's body
     into the reference, where it costs nothing until it is loaded;
   - **keep** — everything whose removal would lose a trigger, a threshold, a path or a name.
   Only `drop` and `distil` shrink the file. `demote` is the safest lever and should be preferred.
4. **Apply only on explicit approval, one skill at a time.** Applying goes through the same path any
   other skill write takes — `skills.write_approval: true` — so it stages, and a human approves it.
   The pass itself never writes a skill file directly, not even the reference: it proposes, and the
   approval mechanism lands it.
5. **Verify after.** Re-run `node bin/verify-untouched` and re-hash the skills. Report the size
   before/after, and — this is the part that matters — a checklist that every hard rule in the
   pre-pass runbook is still present in some form. A distillation that loses a rule is a failure even
   if the file is smaller and every test passes.

## 4. What triggers a pass, and what does not

Not a timer. The signal is *size plus drift*: a pass is worth running when the runbook crosses ~7 KB
(it is 4.5 KB today, so the cap is not close), or when the reference has been contradicted by a
measured result — the same class of event that produced this document's cautionary example, where a
proposal carried a `taskkill` switch form that the actual shell rejects.

A useful precedent already exists in the profile: the review job is gated by a `monitor` script whose
deterministic output decides whether the agent runs at all. A pruning job would be gated the same way
— a cheap script printing the runbook's size and a content hash, so the agent wakes on a real change
rather than on a clock. **That job is not created.** It is named here only so the trigger design is
consistent with the one that already works.

## 5. Failure modes this design accepts

- **A rule that only looks duplicated.** Two rules can share vocabulary while covering different
  triggers. Mitigation: `keep` is the default for anything that names a path, a threshold or a tool;
  only a byte-identical or explicitly superseded line is dropped outright.
- **A snapshot that is never read.** Backups are cheap and useless until someone diffs them. Mitiga-
  tion: the dry-run proposal names the snapshot path, so the diff is one command away from the review.
- **Distillation as a hiding place.** Compressing text is an excellent way to make a rule vanish
  without anyone noticing. Mitigation: the rule-presence checklist in step 5 is the acceptance test,
  and it is written by a human, not by the pass.

## 6. What is deliberately NOT in this design

- No automatic deletion of any skill, ever.
- No change to the runbook that does not stage for approval.
- No touch of `manifest/protected.json` or the protected set: skills are hashed there, and the pass
  must not create the appearance of drift by rewriting a file the baseline tracks.
- No job, no schedule, no cron entry. This is a design; installing it is a separate, approved step.
- **No journal writes.** If a later version records a pruning decision in `journal/decisions.jsonl`, it
  must be an appended event (`src/journal.js`), never an edit. The append-only rule now covers every
  journal — lessons as well as decisions — and it is load-bearing, not aspirational.
