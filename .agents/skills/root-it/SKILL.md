---
name: root-it
description: Names a failure's cause in one sentence, fixes that cause, and adds the guard that would have caught it. Use for any bug, regression, red CI, flaky test, "root cause", "why did this break" or a bug that came back.
---

# Root it

Done: one sentence names the cause, a test that failed before the fix passes after it, and a guard stops
the same fault returning.

1. **Reproduce** on the real surface (page, route, job). Read the actual error and state; instrument, don't
   guess. Have a fresh agent write the failing test (`test-it`) and watch it fail for the reported reason. Fails only after a restart:
   suspect persisted state (caches, config, lock files, rows).
2. **Cause sentence.** "X does Y when Z, because W", with file and line. Ask why until the answer is a wrong
   decision, not a consequence. "Race condition" is not a cause; name what races.
3. **Fix the cause.** A legitimate state: handle it where it breaks. An impossible state: find what made it.
   Retries, sleeps, clamps, swallowed errors and `try/catch` are patches unless the sentence names them. Fix
   every instance of the same fault.
4. **Guard,** the first that fits, saying why not the higher ones:
   1. a type that makes the state impossible (union, branded id, exhaustive match, boundary decode);
   2. a test, written by a fresh agent (`test-it`), that fails before and passes after, where the cause lives (run release scripts in a temp repo;
      grepping workflow text only pins wording);
   3. a lint rule in `tooling/oxlint` when the mistake can recur elsewhere;
   4. a CI step when nothing above can see it.
5. **Design cause** (two sources of truth, copied state, a layer owning the wrong thing): ship the smallest
   cause fix and take the design to `rethink-it`. Two failed fixes in a row: stop and question the premise.

**Reply:** the cause sentence, the reproduction, the test before and after, the guard and its level, other
instances fixed, any design proposal.
