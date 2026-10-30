---
name: test-it
description: Hands test writing to a fresh agent that never saw the code, then uses the change like a real caller (web, API, CLI, desktop, SDK, agent tools) and fixes until clean. Use for "test it", "write tests", or before calling any change done.
---

# Test it

Done: an agent that did not write the code wrote the tests, every test fails when its behavior is broken,
and a full pass through every surface the change touches finds nothing wrong.

## Tests: hand them off

1. **Never write tests for your own code.** Send a fresh agent [references/brief.md](references/brief.md)
   with the requirement, the public entry points and the repo's test commands, never your diff or plan.
2. **The tester writes unit and integration tests** per [references/rules.md](references/rules.md), at
   the level [testing](../../../docs/guides/testing.md) and the owning
   [verification record](../../../docs/internals/verification/README.md) require, and runs them.
3. **A failing test is the code's problem.** Fix the code, or send the tester evidence that the test
   asserts the wrong behavior. Never edit, skip or loosen a test yourself.
4. **The tester proves each test bites:** revert or mutate the line it covers, watch it fail, restore.
   A new test that still passes needs stronger assertions; existing evidence is preserved under `AGENTS.md`.

## Use it: loop until clean

After every change, before saying it's done, on your own stack (`../prove-it/references/stack.md`):

1. List every surface the change touches: documentation UI, framework RPC, CLI, package exports, store,
   actions and jobs. No unrelated hosted stack is required for public framework work.
2. Use each one the way its real caller would, per [references/surfaces.md](references/surfaces.md):
   the happy path, then empty, wrong, duplicate, unauthorized and failing-dependency cases.
3. Look at the actual result every time: the screenshot, response body, terminal output and exit code,
   stored row, log line. Read it; don't assume it.
4. Fix what you find and repeat from step 1. Stop only when a full pass finds nothing.

Then `prove-it`, then `break-it`.

**Reply:** the tester's test list and run output, the break each test failed on, each surface you used
with what each pass found and fixed, and the final evidence (screenshots, outputs, rows).
