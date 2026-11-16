#!/usr/bin/env python3
"""append-lesson.py — append one schema-validated lesson to journal/lessons.jsonl.

Lessons are append-only history, so this appends and never rewrites. The schema is the one B3(b)
fixed: {symptom, root_cause, evidence, proposed_rule, status}. A malformed record would break every
downstream parse, so the record is validated before it is written, and the whole file is re-parsed
after the write.
"""
import json
import sys

FILE = "D:/code/orca-supervisor/journal/lessons.jsonl"
FIELDS = ["symptom", "root_cause", "evidence", "proposed_rule", "status"]
STATUSES = ["proposed", "accepted", "rejected"]

lesson = {
    "symptom": "A cron job's pre-step script failed instantly and the run was recorded as failed with no agent turn at all.",
    "root_cause": "Hermes cron dispatches .sh job scripts through WSL's bash on this host, and WSL is not installed, so a bash script can never start. The failure is in the launcher, not in the script.",
    "evidence": "Run a7923d85c7d5 (job c6ecba5e1ae0, 2026-09-23T20:01:25+03:00): 'Script exited with code 1' plus 'WSL (10 - Relay) ERROR: CreateProcessCommon:818: execvpe(/bin/bash) failed: No such file or directory'. The same two scripts rewritten as Python completed on the next fire (run cba1638224ac4a119e24df7b52b4fb3c).",
    "proposed_rule": "Any Hermes cron job script on this host is Python (.py), never .sh. A .sh job fails before its first line runs.",
    "status": "proposed",
}

errs = [f"missing {f}" for f in FIELDS if f not in lesson]
errs += [f"{f} must be a non-empty string" for f in FIELDS[:4] if not isinstance(lesson.get(f), str) or not lesson[f].strip()]
if lesson["status"] not in STATUSES:
    errs.append("bad status")
if errs:
    print("REJECTED:", "; ".join(errs))
    sys.exit(1)

# A missing trailing newline would fuse this record onto the previous one and break the whole file.
with open(FILE, "rb") as fh:
    fh.seek(0, 2)
    if fh.tell() > 0:
        fh.seek(-1, 2)
        if fh.read(1) != b"\n":
            print("REJECTED: file does not end with a newline; append would corrupt record N")
            sys.exit(1)

with open(FILE, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(lesson) + "\n")

with open(FILE, "r", encoding="utf-8") as fh:
    lines = [l for l in fh.read().splitlines() if l.strip()]
ok = 0
for l in lines:
    try:
        json.loads(l)
        ok += 1
    except Exception:
        pass
print(f"appended; {ok}/{len(lines)} records parse")
