---
name: prove-it
description: The author's proof that a change works on the real stack, through the browser, the endpoints and the stored side effects. Use after any UI, API, data or flow change, for "prove it" or "show me", and before break-it.
---

# Prove it

Done: every claim has evidence from the running system on the exact SHA you ship. New code, new proof.

1. **Stacks.** Your own stack and a before stack on the base commit
   ([references/stack.md](references/stack.md)).
2. **Before and after.** For a UI change, one capture script on both surfaces: 1440×900 and 390×844 at
   pixel ratio 2, every changed state (empty, filled, error), and a desktop video of the flow (`browse-it`).
   Pixel-diff after against before. Only the intended change may differ; name any other region and why, and
   compare the changed element's text too. Hold loading states open by pausing the API (stack reference).
3. **Public boundary.** Use the real caller: Effect client over `/rpc`, CLI, package consumer, or browser
   for docs. Record input and outcome for happy path, invalid input, duplicate and concurrent calls.
   For authenticated framework calls, test missing credentials and denied caller/tenant scope according
   to the owning contract; do not invent REST routes, browser personas or HTTP status guarantees.
4. **Side effects.** Read durable actor state, segment/log evidence, jobs and files where they landed.
   After duplicate, concurrent or rejected calls, verify both the state and pending obligations. Use
   seeded Simulation and bucket evidence at the level [testing](../../../docs/guides/testing.md) requires.
5. **Checks.** Choose the root and package commands from their manifests and the owning
   [verification record](../../../docs/internals/verification/README.md); `bun run check` is the full root check.
   Prove the regression test fails on the wrong implementation without weakening existing tests.
   For documentation-only edits, audit links/paths and formatting; don't start an unrelated stack.
   Clean up (stack reference), then hand the SHA to `break-it`.

**Reply:** SHA and tested surface; before, after and diff images and the video when applicable; the public-call table; side-effect
queries with results; check output; what you could not check.
