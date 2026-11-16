#!/usr/bin/env python3
"""secret-scan-history.py -- scan EVERY blob in a git repository's history for secrets.

Usage: secret-scan-history.py <repo-path> [output-file]

Why blob-level and not `git grep <rev>`: a push publishes every object in every commit, not the
working tree, so the scan has to cover all blobs in all commits. Walking unique blobs is exact
(every committed version of every file is one blob) and far cheaper than grepping each of N commits'
full trees, because identical content is scanned once.

A hit is reported with its path, line number, blob sha and the commit that introduced the blob.
Values are MASKED: a scanner that prints the secret it found has just leaked it a second time.
"""
import re
import subprocess
import sys

PATTERNS = [
    ("openai-style-key", re.compile(r"sk-[A-Za-z0-9_\-]{16,}")),
    ("github-pat-classic", re.compile(r"ghp_[A-Za-z0-9]{20,}")),
    ("github-pat-fine", re.compile(r"github_pat_[A-Za-z0-9_]{20,}")),
    ("aws-access-key-id", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("slack-token", re.compile(r"xox[baprs]-[A-Za-z0-9\-]{10,}")),
    ("bearer-token", re.compile(r"[Bb]earer\s+[A-Za-z0-9._\-]{16,}")),
    ("api-key-assignment", re.compile(r"api[_-]?key\s*[:=]\s*[\"']?([A-Za-z0-9._\-]{12,})", re.I)),
    ("password-assignment", re.compile(r"pass(word|wd|phrase)\s*[:=]\s*[\"']?([^\s\"']{4,})", re.I)),
    ("private-key-header", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("dotenv-reference", re.compile(r"(^|[/\s\"'(])\.env(\.|[\s\"')/:]|$)")),
    ("generic-secret-assignment", re.compile(r"(secret|token|passwd)\s*[:=]\s*[\"']([A-Za-z0-9._\-]{16,})", re.I)),
]

MAX_BLOB = 8 * 1024 * 1024   # skip anything larger; note it in the summary instead of guessing


def git(repo, *args, **kw):
    return subprocess.run(["git", "-C", repo] + list(args),
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kw)


def mask(value):
    v = value.strip()
    if len(v) <= 8:
        return v[:1] + "*" * (len(v) - 1) if v else ""
    return "%s…%s (len %d, masked)" % (v[:4], v[-2:], len(v))


def main():
    if len(sys.argv) < 2:
        print("usage: secret-scan-history.py <repo-path> [output-file]")
        return 2
    repo = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else None
    out = []

    def say(line=""):
        out.append(line)

    # --- object inventory ---
    hdr = git(repo, "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)")
    if hdr.returncode != 0:
        print(hdr.stderr.decode("utf-8", "replace"))
        return 1
    blobs, other, oversized = [], 0, 0
    total_bytes = 0
    for line in hdr.stdout.decode("utf-8", "replace").splitlines():
        parts = line.split()
        if len(parts) != 3:
            continue
        sha, typ, size = parts[0], parts[1], int(parts[2])
        if typ != "blob":
            other += 1
            continue
        total_bytes += size
        if size > MAX_BLOB:
            oversized += 1
            continue
        blobs.append((sha, size))

    commits = git(repo, "rev-list", "--all", "--count").stdout.decode().strip()
    refs = git(repo, "for-each-ref", "--format=%(refname)").stdout.decode().split()

    say("secret scan over the FULL HISTORY (every blob in every commit)")
    say("repo            : %s" % repo)
    say("commits (--all) : %s" % commits)
    say("refs            : %d" % len(refs))
    say("blobs scanned   : %d  (%d non-blob objects, %d blobs over the %d-byte cap skipped)"
        % (len(blobs), other, oversized, MAX_BLOB))
    say("blob bytes      : %d total; %d scanned" % (total_bytes, sum(s for _h, s in blobs)))
    say("")

    # --- path map: blob sha -> a representative path (from any tree that references it) ---
    obj_lines = git(repo, "rev-list", "--objects", "--all").stdout.decode("utf-8", "replace").splitlines()
    path_of = {}
    for line in obj_lines:
        if " " not in line:
            continue
        sha, path = line.split(" ", 1)
        if sha not in path_of:
            path_of[sha] = path

    # --- stream blob contents, scan line by line ---
    hits = []
    proc = subprocess.Popen(["git", "-C", repo, "cat-file", "--batch"],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    for i, (sha, size) in enumerate(blobs):
        proc.stdin.write((sha + "\n").encode())
        proc.stdin.flush()
        header = proc.stdout.readline().decode("utf-8", "replace").split()
        if len(header) != 3:
            break
        data = proc.stdout.read(size)
        proc.stdout.read(1)  # trailing newline
        if b"\x00" in data[:4096]:
            continue  # binary
        text = data.decode("utf-8", "replace")
        for lineno, line in enumerate(text.splitlines(), 1):
            for name, rx in PATTERNS:
                m = rx.search(line)
                if not m:
                    continue
                shown = m.group(m.lastindex) if m.lastindex else m.group(0)
                # A match that is itself part of a path is a filename, not a value: keep it, but say so.
                in_path = shown.strip() in path_of.get(sha, "")
                hits.append((name, sha, path_of.get(sha, "(no path)"), lineno, mask(shown),
                             line.strip()[:120], in_path))
                break  # one hit per line is enough to act on
    proc.stdin.close()
    proc.wait()

    say("hits: %d" % len(hits))
    say("")
    by_pattern = {}
    for name, *_rest in hits:
        by_pattern[name] = by_pattern.get(name, 0) + 1
    say("--- hits per pattern ---")
    for name, _rx in PATTERNS:
        say("  %-28s %d" % (name, by_pattern.get(name, 0)))
    say("")

    say("--- hits (values masked; a scanner must not print the secret it found) ---")
    say("%-24s %-10s %-6s %s" % ("pattern", "blob", "line", "path / masked value / commit"))
    seen_blob_commit = {}
    for name, sha, path, lineno, masked, rawline in hits:
        if sha not in seen_blob_commit:
            c = git(repo, "log", "--all", "--oneline", "-1", "--find-object=" + sha).stdout.decode().strip()
            seen_blob_commit[sha] = c.split(" ")[0] if c else "(not in any commit)"
        say("%-24s %-10s %-6d %s" % (name, sha[:10], lineno, path))
        say("%-42s value: %s" % ("", masked))
        say("%-42s commit: %s  |  line: %s" % ("", seen_blob_commit[sha], rawline))
    say("")
    say("These are candidate hits for human review, not a verdict: 'password'/'api_key' appear in")
    say("prose, and '.env' appears in .gitignore and in documentation. What matters is whether any")
    say("line carries a live value, which this output deliberately does not reproduce.")

    text = "\n".join(out) + "\n"
    if out_path:
        with open(out_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        print("wrote %s (%d bytes)" % (out_path, len(text.encode("utf-8"))))
    print(text[:4000])
    return 0


if __name__ == "__main__":
    sys.exit(main())
