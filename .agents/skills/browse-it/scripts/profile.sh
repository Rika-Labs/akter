#!/usr/bin/env bash
# Prints the aside flags for a browser profile chosen by its display name.
# Usage: profile.sh <name>   ->   --account uN --profile <profile id>
# With no name, lists every profile as: name | account | profile id.
set -euo pipefail
python3 - "${1:-}" <<'PY'
import json, os, sys
want = sys.argv[1].strip().lower()
support = os.path.expanduser("~/Library/Application Support/Aside")
names = json.load(open(os.path.join(support, "Local State")))["profile"]["info_cache"]
bindings = json.load(open(os.path.expanduser("~/.aside/accounts.json")))["profileAccountBindings"]
rows = []
for b in bindings.values():
    folder = os.path.basename(b["profilePath"])
    rows.append((names.get(folder, {}).get("name", folder), f"u{b['accountId']}", b["profileId"]))
if not want:
    for r in rows: print(" | ".join(r))
    sys.exit(0)
match = [r for r in rows if r[0].lower() == want]
if not match:
    sys.exit(f"no Aside profile named {sys.argv[1]!r}; have: " + ", ".join(r[0] for r in rows))
print(f"--account {match[0][1]} --profile {match[0][2]}")
PY
