#!/usr/bin/env node
// src/capacity.js — D1's answer, asked live, every time.
//
// This is deliberately NOT a calibration. Capacity is read from the machine at the moment the question
// is asked, and the answer is whatever is true then. The user's rule, after watching a D1 measurement
// session: "the machine will always be running a mix of things, and that's exactly the real-world
// condition D1's capacity check needs to handle." So there is no cached number, no "this machine has N
// slots" constant, and no assumption that anything was closed to make room.
//
// Measured on this host (7,515 MB physical), 2026-09-25:
//   * one opencode worker: ~400 MB peak RSS, ~100 MB idle, +2 processes (2 samples)
//   * free RAM moved 977 MB -> 1,850 MB while load was being ADDED, and 740 MB -> 406 MB with no load
//     change at all (10 s apart). A remembered number is worse than useless here.
//   * closing 11 idle sandbox terminals (8 opencode processes, ~800 MB RSS) moved available memory
//     from 740 MB to 681 MB — it did NOT create headroom. Another reason not to "prepare" the machine
//     before asking.
//   * npm ci peak: NOT measured. An honest gap — see docs/d1-capacity.md.
//
// The reader is os.freemem(). On this host it matched Win32_PerfFormattedData AvailableMBytes
// (740 vs 736 MB) and WMI FreePhysicalMemory (681 vs 688 MB) within 7 MB at two separate moments, so
// either source is fine and this one needs no child process — which matters, because
// src/guard/exec.js is the only file in src/ allowed to spawn.
const os = require('os');
const fs = require('fs');
const path = require('path');

// D1's spec keeps the thresholds in config/capacity.json (each value's basis is recorded there). The
// numbers below are the fallback for a machine where that file is missing or unparseable, so a broken
// config can never silently move a safety floor. The file and the fallback carry the same values today.
const V2 = path.dirname(__dirname);
const CONFIG_FILE = path.join(V2, 'config', 'capacity.json');

function thresholds() {
  const fallback = { margin_mb: 700, peak_mb_per_worker: 400 };
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      margin_mb: Number.isFinite(j.margin_mb) ? j.margin_mb : fallback.margin_mb,
      peak_mb_per_worker: Number.isFinite(j.peak_mb_per_worker) ? j.peak_mb_per_worker : fallback.peak_mb_per_worker,
    };
  } catch (e) {
    return fallback;
  }
}

const { margin_mb: MARGIN_MB, peak_mb_per_worker: PEAK_MB_PER_WORKER } = thresholds();

/**
 * Read the machine's state right now and compute how many workers fit.
 * Never cached. Safe to call once per decision, which is the only way it is meant to be used.
 * @returns {{available_mb:number, margin_mb:number, peak_mb_per_worker:number, free_slots:number,
 *            basis:string, taken_at_utc:string, source:string}}
 */
function freeSlots() {
  const available_mb = Math.round(os.freemem() / (1024 * 1024));
  const usable = available_mb - MARGIN_MB;
  const free_slots = usable <= 0 ? 0 : Math.floor(usable / PEAK_MB_PER_WORKER);
  return {
    available_mb,
    margin_mb: MARGIN_MB,
    peak_mb_per_worker: PEAK_MB_PER_WORKER,
    free_slots,
    basis: `floor((${available_mb} - ${MARGIN_MB}) / ${PEAK_MB_PER_WORKER}), floored at 0`,
    taken_at_utc: new Date().toISOString(),
    source: 'os.freemem(), read live on every call, never cached',
  };
}

module.exports = { freeSlots, MARGIN_MB, PEAK_MB_PER_WORKER };
if (require.main === module) console.log(JSON.stringify(freeSlots(), null, 2));
