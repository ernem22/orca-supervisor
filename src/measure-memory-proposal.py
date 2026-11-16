#!/usr/bin/env python3
"""measure-memory-proposal.py — count the characters each proposed memory entry would cost.

The budget claim in docs/memory-proposal.md is only worth anything if it is measured against the
actual text, so this parses that document and counts the entries rather than estimating them.
"""
import re

DOC = "D:/code/orca-supervisor/docs/memory-proposal.md"

with open(DOC, "r", encoding="utf-8") as fh:
    text = fh.read()

sections = re.split(r"^## ", text, flags=re.M)
for sec in sections:
    head = sec.splitlines()[0] if sec.strip() else ""
    if not head.startswith(("A.", "B.")):
        continue
    items = re.findall(r"^\d+\.\s+(.*?)(?=^\d+\.\s|^---|^\Z)", sec, flags=re.M | re.S)
    total = 0
    print("## %s" % head.strip())
    for i, raw in enumerate(items, 1):
        body = " ".join(raw.split())
        n = len(body)
        total += n
        print("   %2d. %4d chars" % (i, n))
    print("   total: %d chars (%d entries)" % (total, len(items)))
    print()
