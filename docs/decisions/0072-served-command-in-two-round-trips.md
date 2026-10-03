# ADR 0072: A served command in two database round trips

**Status:** implementation decision (2026-10-03), for #493; amends ADR 0020's pre-delivery reads.

**Responsibility:** remove the database flights surrounding the fenced turn without speculative execution or an admission-clock expiry recheck.

**Authority:** design decision record.

**Owner role:** runtime and performance.

**Change policy:** supersede through a new ADR.

## Context

The turn already sends admission and commit as two pipelined groups. Dispatch adds a receipt/admission read before delivery and a database-clock read before returning the outcome. A served command therefore waits for four database flights, although the turn-pool instrument reports two. ADR 0020 kept these surrounding reads because replay could avoid routing to the owner and expiry must not use the admission clock.

## Decision

Dispatch checks external authorization before any turn and checks the command id's form and configured window without reading the database. It then routes both new commands and retries to the owner. The fenced admission read already joins the command's receipt and canonicalizes its payload. On the first external delivery it also validates issued time and expiry against its own `clock_timestamp()` before releasing a retained outcome or running the handler. Receipt caller and payload checks still run under the generation fence. A replay never invokes the handler, decodes state through migrations, or rewrites the receipt.

Runtime redeliveries after a retryable failure retain the existing recovery allowance only once the owner explicitly reports that an earlier attempt passed fenced admission; its commit may be unknown. The internal RPC failure carries that admission status separately from the public `ActorError`. A connection failure or capacity rejection alone grants no expiry exception. An admitted redelivery can resolve the receipt, or finish the original operation within the retention safety margin. A fresh external request cannot supply that redelivery flag. Once retention could have pruned the receipt, a missing receipt with an expired id is still rejected. Every external result remains subject to the final expiry and authorization checks; recovery is not permission to deliver an expired result.

The commit-version statement now reads both the WAL insert position and a fresh `clock_timestamp()`. It executes on the turn's session **after `COMMIT` or `ROLLBACK`**, in the same queued flight and before a following batch's `BEGIN`. The command tag must still prove `COMMIT` before publication. The reply carries the framework-adjusted clock internally to dispatch, which rechecks authorization and validates expiry against it. This is a distinct server clock read after the transaction ended, not a reuse of admission time. A defect that never completed a turn has no such clock and retains its separate database-clock read.

PGlite runs the same admission checks and reads the version and clock after `withTransaction` finishes, whether it committed or rolled back. It has engine calls rather than network flights. Command-id minting still reads database time separately. Handler-issued SQL, cold rehydration, workflow work, connection publication, faults and activation recovery can add work; the two-flight target is an ordinary command without those additions, using a supplied id.

## Independently derived cost

For a warm command that dirties one state key, admission sends `BEGIN`, timeout configuration and the fenced receipt read: three statements in one flight. Commit sends the state upsert, receipt insert, `COMMIT` and the combined version/clock read: four statements in one flight. The total is **seven statements and two flights**, versus the preceding nine statements and four flights across both pools.

A warm replay sends the same three admission statements, then `ROLLBACK` and the version/clock read: **five statements and two flights**. It previously cost two off-turn statements and two flights. Replays now incur owner routing and a fence; a cold replay can acquire a new generation. This is the deliberate tradeoff for removing every new command's pre-delivery read, not a replay speedup.

## Evidence and scope

`testing/conformance/statements.ts` records the independently derived seven/five statement expectations. The every-pool Postgres relay case checks two flights for a command and its replay, records the wire statements, and proves the replay leaves the handler count unchanged. The receipt suite retains payload conflicts, caller denial, pruning, lost replies and fenced replay races. The expiry case pauses after admission until the id expires, then verifies the receipt committed but delivery fails `CommandExpired`; using admission time for the final check would incorrectly return success. External presentation of the redelivery flag is refused before any handler or receipt. The capacity case keeps every resident slot occupied until the id expires and verifies that later availability does not run a handler or commit a receipt; granting recovery from delivery-attempt count alone would fail that check.

Replays now have a turn span with `turn.replayed=true` and `turn.outcome=replay`; they no longer short-circuit within an admission span. This amends ADR 0049's `admission.replayed` attribution. The telemetry checks wait for the turn's finalizer because a caller can receive its reply before the turn span ends. Restart replay evidence permits the new fenced generation while retaining equality of state and receipt counts.

The same-setup Docker measurements and verification commands are recorded in [BENCHMARKS.md](../../BENCHMARKS.md). No Neki, WAN, cloud-provider, or production latency claim follows from local Postgres/PGlite evidence. No storage migration or public command-id format changes.

Owner-side admission also needs to retain the origin runtime's framework-clock interpretation across a runner hop. Dispatch supplies its internal clock offset with the external request, and the owner applies it to the fresh admission clock; an external caller cannot supply that metadata. The commit flight returns raw database time, and dispatch applies its own offset for the final expiry check. This preserves `ActorTest.cluster`'s deliberately independent per-runner clocks for lease/takeover drills instead of changing the whole simulation clock. Production offsets are zero, and the database clock remains the authority. The existing cross-runner timer/effect scenario and forged-metadata rejection cover this boundary.
