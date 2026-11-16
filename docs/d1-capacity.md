# D1 — capacity, measured live

**Closing answer for this pass, asked with the machine in its real, unmodified state (nothing closed to
make room): `free_slots = 0`.**

```json
{
  "available_mb": 915,
  "margin_mb": 700,
  "peak_mb_per_worker": 400,
  "free_slots": 0,
  "basis": "floor((915 - 700) / 400), floored at 0",
  "taken_at_utc": "2026-09-25T14:28:48.682Z",
  "source": "os.freemem(), read live on every call, never cached"
}
```

915 MB available minus the 700 MB margin leaves 215 MB, which does not fit one worker's 400 MB peak. That
is a real answer about this machine right now, not a failure to measure: **the pipeline should not spawn
on this machine while it is in this state**, and the load holding it there is not ours.

## What the machine looked like when the answer was computed

Untouched — no process closed, nothing "prepared" for the measurement:

```
Available MBytes      876–915 MB  of 7,515 MB total
claude     14 procs   1,116 MB    ← not ours
chrome     13 procs     959 MB    ← not ours
Orca        8 procs     452 MB
MsMpEng     1 proc      337 MB
node       19 procs      11 MB
```

## The rule, and why it is a live reading

`src/capacity.js` reads the machine, subtracts a safety margin, divides by the measured per-worker peak,
and floors at zero — **recomputed on every call**. No cached number, no "this machine has N slots"
constant, no assumption that anything was closed first. The user's framing, after watching a measurement
session: *"the machine will always be running a mix of things, and that's exactly the real-world
condition D1's capacity check needs to handle."*

Three measurements made the live reading the only defensible design:

1. **Free RAM moved ~1.5 GB with no load change.** It rose from 977 MB to 1,850 MB while load was being
   *added*, and fell from 1,086 MB to 406 MB while nothing was running. A remembered number is worse than
   useless.
2. **Closing load did not create headroom.** Closing 11 idle sandbox terminals (8 opencode processes,
   ~800 MB RSS — everything of ours) moved available memory from 740 MB to 681 MB. The machine settles
   where it settles; "prepare first, then measure" measures a state that will not exist at decision time.
3. **`os.freemem()` and the two Windows counters agree.** Against `Win32_PerfFormattedData`
   AvailableMBytes: 740 vs 736 MB. Against WMI FreePhysicalMemory: 681 vs 688 MB. Within 7 MB at two
   separate moments, so any of the three is fine — and `os.freemem()` needs no child process, which
   matters because `src/guard/exec.js` is the only file in `src/` allowed to spawn.

## The constants, and where they come from

| constant | value | source |
|---|---|---|
| `MARGIN_MB` | 700 | D1's stated stop-adding-load floor |
| `PEAK_MB_PER_WORKER` | 400 | measured: one opencode worker peaked at 402 MB during work, then idled to 116 MB; +2 processes |

The **peak** is what the arithmetic uses, not the ~100 MB idle figure — a worker has to fit at its worst
moment or the machine fails at its worst moment.

## Honest gaps in this pass

- **`npm ci` peak: not measured.** Per-worker RSS is measured (~400 MB peak), but the build-time peak on
  top of it is not. Measuring it required more headroom than this machine had without closing unrelated
  processes, and closing them to create measurement conditions was explicitly rejected. A future
  measurement should capture it **opportunistically** — during a real E2 or live scenario that already
  builds — rather than requiring anyone to free RAM on demand. Until then the build peak is an unknown
  added to the margin, not a measured term.
- **Two samples for the per-worker peak**, not a distribution. Enough to set a margin, not enough to claim
  a variance.
- **Single host.** This is one 7,515 MB Windows machine; nothing here generalises to another.
- **`MARGIN_MB = 700` drives today's zero.** At 915 MB available, a 400 MB margin would have produced 1
  slot. The margin is a judgement call carried over from the measurement ground rule, not a measurement —
  if the pipeline should spawn more aggressively on a machine this loaded, that constant is the dial, and
  changing it should be a deliberate decision rather than a discovery.
