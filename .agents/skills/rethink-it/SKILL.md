---
name: rethink-it
description: Designs the right solution as if no code existed, compares it with the current plan or code, and decides how much to take now. Use when a change keeps fighting the code, or for "rethink it", "clean slate" or "if we built it today".
---

# Rethink it

Done: a ground-zero design, a gap table with costs on both sides, and one recommendation: A, B or C.

Bigger than one file? Send a fresh agent [references/brief.md](references/brief.md); it designs before it
reads the current code. Smaller: write step 3 before opening the code.

1. **Problem and invariants.** The user-facing problem in one sentence, then what must stay true: data,
   behavior users rely on, latency and cost limits.
2. **Constraints.** Real: product decisions, provider limits, existing data, security, `AGENTS.md` rules,
   money, time. Incidental: module split, schema, library choice, workarounds, stale decisions. Only real
   ones bind.
3. **Ground-zero design.** One page: who owns which data and state, one user action end to end, failures and
   retries, scaling. Cite what you borrow from strong products or libraries (their documentation or web search).
4. **Gap table.** Read the plan and code. Per difference: what forces it today, the cost of keeping it (bugs,
   speed, blocked features, with evidence), the cost of moving (files, migration, risk, mixed versions). Name
   files, types or tables; "cleaner" is not a cost.
5. **Decide.**
   - **A. Take it now:** small gap, or the current shape causes the bug at hand.
   - **B. Bend the plan toward it:** same scope; name the seams to add and the parts that would deepen the
     gap.
   - **C. Ship as is:** record the design and the trigger that would justify it.

A big migration for a small gain loses to B or C. Architecture, data model and product changes go to the
owner the user names, as numbered options with a recommendation. Run `simplify-it` on the
winner.

**Reply:** A, B or C on the first line, then invariants, real vs incidental constraints, the design, the gap
table, and what goes to the owner.
