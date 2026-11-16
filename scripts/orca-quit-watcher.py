#!/usr/bin/env python3
"""Orca GUI-quit watcher for cutover item 11.

Waits for the Orca GUI window process to disappear, checks that the daemon that owns the PTYs is
still alive (if it is not, this ABORTS without touching anything), applies exactly one key to
orca-data.json (settings.agentDefaultEnv.opencode = {}), then waits for the GUI to come back.

Why a watcher instead of a chat round-trip: this agent runs inside an Orca terminal pane, so when the
user quits the GUI they cannot type anything to it. The docs say the PTYs are owned by a background
daemon, not the GUI window, so this process keeps running and can act in the gap.

Identified from tasklist before writing this (2026-09-25):
  GUI     : Orca.exe, MainWindowTitle 'Orca', path ...\\AppData\\Local\\Programs\\orca\\Orca.exe
  daemon  : Orca.exe, no window,            path ...\\AppData\\Local\\Orca\\daemon-host\\<ver>\\Orca.exe
"""
import json, os, subprocess, sys, time, hashlib, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "evidence", "settings", "watcher-result.json")
DATA = os.path.join(os.environ["APPDATA"], "orca", "profiles", "local-default", "orca-data.json")
KEY = "opencode"
POLL = 5                 # seconds between samples
GUI_GONE_TIMEOUT = 45 * 60    # how long to wait for the user to quit
GUI_BACK_TIMEOUT = 20 * 60    # how long to wait for them to reopen


def ps(script):
    r = subprocess.run(["powershell", "-NoProfile", "-Command", script],
                       capture_output=True, text=True, timeout=60)
    return (r.stdout or "").strip()


def gui_alive():
    """A windowed Orca.exe from the Programs install = the GUI is up."""
    out = ps("(Get-Process Orca -ErrorAction SilentlyContinue | "
             "Where-Object { $_.MainWindowTitle -and $_.Path -like '*Programs\\orca*' }).Count")
    try:
        return int(out or "0") > 0
    except ValueError:
        return None      # unreadable -> caller treats as ambiguous


def daemon_alive():
    out = ps("(Get-Process Orca -ErrorAction SilentlyContinue | "
             "Where-Object { $_.Path -like '*daemon-host*' }).Count")
    try:
        return int(out or "0") > 0
    except ValueError:
        return None


def write(result, **kw):
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    doc = {"taken_at_utc": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"), "result": result}
    doc.update(kw)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
    print("RESULT:", result, json.dumps(kw)[:400])


def main():
    write("started", gui_alive=gui_alive(), daemon_alive=daemon_alive())

    # 1) wait for the GUI to go away
    t0 = time.time()
    while time.time() - t0 < GUI_GONE_TIMEOUT:
        g = gui_alive()
        if g is None:
            write("aborted", reason="could not read GUI process state unambiguously", elapsed_s=int(time.time() - t0))
            return 2
        if g is False:
            break
        time.sleep(POLL)
    else:
        write("timeout_waiting_for_quit", elapsed_s=int(time.time() - t0), gui_alive=gui_alive())
        return 3

    time.sleep(3)                                  # let the GUI teardown settle
    d = daemon_alive()
    if d is None:
        write("aborted", reason="could not read daemon process state after GUI exit")
        return 2
    if d is False:
        # The docs promised the daemon outlives the GUI. It did not. Do NOT edit anything.
        write("aborted_daemon_also_gone",
              reason="GUI exited AND the daemon-host process is gone; the safety premise does not hold",
              daemon_alive=False)
        return 4

    # 2) the single-key edit, with a before/after record
    with open(DATA, "r", encoding="utf-8") as f:
        raw = f.read()
    before_sha = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    doc = json.loads(raw)
    env = doc.setdefault("settings", {}).setdefault("agentDefaultEnv", {})
    before_env = json.dumps(env, sort_keys=True)
    added = KEY not in env
    env[KEY] = {}
    after_raw = json.dumps(doc, ensure_ascii=False)
    with open(DATA, "w", encoding="utf-8") as f:
        f.write(after_raw)
    with open(DATA, "r", encoding="utf-8") as f:
        after_sha = hashlib.sha256(f.read().encode("utf-8")).hexdigest()
    write("edited", added_key=added, agentDefaultEnv_before=before_env,
          agentDefaultEnv_after=json.dumps(json.loads(after_raw)["settings"]["agentDefaultEnv"], sort_keys=True),
          sha256_before=before_sha[:16], sha256_after=after_sha[:16], daemon_alive=True)

    # 3) wait for the GUI to come back
    t0 = time.time()
    while time.time() - t0 < GUI_BACK_TIMEOUT:
        if gui_alive() is True:
            write("reopened_and_edited", elapsed_s=int(time.time() - t0), sha256_after=after_sha[:16])
            return 0
        time.sleep(POLL)
    write("edited_but_not_reopened", elapsed_s=int(time.time() - t0), sha256_after=after_sha[:16])
    return 5


if __name__ == "__main__":
    sys.exit(main())
