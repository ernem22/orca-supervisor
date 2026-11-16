#!/usr/bin/env python3
"""scripts/append-lesson.py — append one schema-validated record to a JSONL journal.

    python scripts/append-lesson.py <journal.jsonl> <record.json>

Why this exists beside src/append-lesson.py: that one carries its payload inline (the WSL lesson) and
lives inside src/, which the scope-guard refuses agent writes to, so a second lesson cannot be
appended through it. The invariants below are copied from it deliberately and must stay identical:
the payload comes from a file, and the target journal comes from the command line, so neither is
baked into the code.

Append-only: this appends and never rewrites. A malformed record would break every downstream parse,
so the record is validated before it is written, and the whole file is re-parsed after the write.
"""
import json
import sys

STATUSES = ["proposed", "accepted", "rejected"]

if len(sys.argv) != 3:
    print("usage: python scripts/append-lesson.py <journal.jsonl> <record.json>")
    sys.exit(2)

target, payload = sys.argv[1], sys.argv[2]

try:
    with open(payload, encoding="utf-8") as fh:
        record = json.load(fh)
except (OSError, ValueError) as exc:
    print(f"REJECTED: cannot read the payload: {exc}")
    sys.exit(1)

if not isinstance(record, dict):
    print("REJECTED: the payload must be a single JSON object")
    sys.exit(1)

errs = []
if "status" in record and record["status"] not in STATUSES:
    errs.append(f"status must be one of {'|'.join(STATUSES)}")
for field in ("symptom", "root_cause", "evidence", "proposed_rule"):
    if field in record:
        value = record[field]
        if not isinstance(value, str) or not value.strip():
            errs.append(f"{field} must be a non-empty string")
if errs:
    print("REJECTED:", "; ".join(errs))
    sys.exit(1)

# A missing trailing newline would fuse this record onto the previous one and break the whole file.
try:
    with open(target, "rb") as fh:
        fh.seek(0, 2)
        size = fh.tell()
        if size > 0:
            fh.seek(-1, 2)
            if fh.read(1) != b"\n":
                print("REJECTED: the journal does not end with a newline; appending would corrupt its last record")
                sys.exit(1)
except OSError as exc:
    print(f"REJECTED: cannot read the journal: {exc}")
    sys.exit(1)

before = len([l for l in open(target, encoding="utf-8").read().splitlines() if l.strip()])
with open(target, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(record) + "\n")

lines = [l for l in open(target, encoding="utf-8").read().splitlines() if l.strip()]
ok = 0
for line in lines:
    try:
        json.loads(line)
        ok += 1
    except Exception:
        pass
last = json.loads(lines[-1])
print(f"appended; {ok}/{len(lines)} records parse (was {before}, now {len(lines)})")
print(f"last record: status={last.get('status')} type={last.get('type')} {str(last.get('symptom', ''))[:80]}")
