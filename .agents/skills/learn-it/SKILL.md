---
name: learn-it
description: Traces how a subsystem actually works through its code, tests and history, and writes a short map with a diagram before anything changes. Use for "learn it", "how does X work", "where does this live", or before changing unfamiliar code.
---

# Learn it

Done: a one-page map, every claim on it backed by a `file:line`, that another agent could use to make the
change without rereading the code.

1. **Question.** Write what you need to know in one sentence, and the change it's for.
2. **Entry points.** Find where the behavior starts: the route, page, actor action, CLI command, job or
   workflow. Search by the user-visible word and Akter's terms from [README.md](../../../README.md) and
   the owning [runtime contract](../../../docs/internals/contracts/README.md).
3. **Trace one real case** end to end through the actual code: who calls whom, what data moves, where
   state is stored, where access is checked, where it can fail. Run it on your stack if reading leaves
   doubt (`../prove-it/references/stack.md`).
4. **Read the tests** for that path and the owning contract. Tests show existing evidence, not authority
   over the 0.2 target; check [guarantees and limits](../../../docs/reference/guarantees.md).
5. **Read the history** for the surprising parts: `git log -S '<symbol>'`, `git log --follow <file>`,
   `git blame`. The commit message usually says why.
6. **Fan out when it's big.** For a subsystem spanning several apps or packages, send 2–4 fresh agents in
   parallel, one per slice (for example web, API, actors, data), each returning facts with `file:line`.
   Merge their findings yourself.
7. **Write the map** in [references/map.md](references/map.md)'s shape, with one diagram per
   `../explain-it/references/visuals.md`. Mark anything you inferred rather than read as "inferred".

**Reply:** the map: the answer in two sentences, the diagram, the traced case, where things live, the
rules and gotchas, and what is still unknown.
