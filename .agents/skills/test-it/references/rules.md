# Test rules

## Test behavior, not the implementation

- Assert what a caller or person can observe: returned values, stored rows, HTTP status and body,
  rendered text, emitted events. Never assert which private function was called.
- Derive expected values from the requirement. Never copy them from the code's output.
- One behavior per test, named as the behavior ("rejects an expired invite"), so a failure says what broke.
- No snapshot of whole objects or markup when one field or line is the behavior.

## Use the real thing

- Read the owning contract and [testing guide](../../../../docs/guides/testing.md). Use the seeded
  `Simulation` for engine failures and scheduling; never inject wall-clock or random I/O into actions.
- Do not mock the boundary whose behavior the test claims to prove. Use real buckets for protocol
  behavior, MinIO for S3-compatible integration and the actual provider for provider support; filesystem,
  simulator and MinIO evidence cannot substitute for provider-specific evidence.
- Reuse the existing fixtures and failure suites in `tooling/conformance` and `packages/akter/src/testing`
  before adding a harness. External job effects need explicit ambiguity and idempotency evidence.
- No sleeps or retries to make a test pass; wait on the observable condition.

## Catch the cheap bugs first

Cover these before anything clever, wherever they apply:

- empty, missing, null and whitespace input; the largest allowed and one past it;
- zero, one and many items; first and last item; ordering and ties;
- denied caller, wrong tenant or another actor's id, where the contract defines access: nothing leaked;
- the same request twice and two at once: one effect;
- each dependency failing (error, timeout, unknown outcome): the right message, nothing corrupted;
- dates at midnight, daylight-saving edges and the viewer's time zone;
- unicode, long names and right-to-left text;
- the UI states a person sees: empty, loaded, error, disconnected, no loading flash.

## Prove the test bites

- Each test must fail when its behavior is broken: revert or mutate the covered line and watch it fail.
- A new test that passes against the broken code needs stronger evidence. Never delete an existing test
  without the replacement evidence or accepted behavior removal that `AGENTS.md` requires.
- Never weaken an assertion, add `.skip`, or widen a tolerance to get green.

## Place it right

- Tests are colocated as `x.test.ts` beside the owner (example filename). Follow the
  [repository structure](../../../../docs/architecture/repository-structure.md); deviations need an entry
  in `tooling/structure/src/exemptions.ts`. `bun run lint:structure` checks placement.
- Reuse the owner's fixtures and runners; don't invent a new harness.
