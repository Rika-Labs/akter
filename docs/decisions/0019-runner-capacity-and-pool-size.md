# ADR 0019: Runner capacity and Postgres pool size

**Status:** accepted (2026-09-25, Dallen, on #39 and #42)

## Context

Effect Cluster admits at most `maxResidentEntities` resident entities per runner (default 10,000), and the runtime didn't set it. When a command needed a new activation past that limit, Cluster failed it with its `MailboxFull` error, and the runtime reported that as `ActorError(MailboxFull)`. The [error model](../contracts/error-model.md) reserves `MailboxFull` for an actor with a finite `Mailbox.capacity`, and the handle types list it only for those actors. So an unbounded actor returned a reason its own types rule out, and the handle didn't retry it. The benchmark harness ([ADR 0018](0018-benchmark-harness-and-results.md)) showed 8,241–11,680 such failures when 64 callers touched 100,000 actors (#39).

Cluster uses the same error for both causes: a resident entity whose mailbox is full, and a runner with no slot to start a new entity. The error carries only the address.

`Database.postgres` passed no pool size, so the driver's default of 10 connections applied. A command holds one connection for its whole turn. With 64 callers over 10,000 warm actors, p99 was 1.37 s at 10 connections and 0.38 s at 50 (#42).

## Decision

- `Actors.layer` accepts `maxResidentActors`, a positive integer that defaults to 10,000. It sets Cluster's `maxResidentEntities`. The name follows [API naming](../api/naming.md): it counts actors, not Cluster entities, and it describes a runner, so it's a layer option, not an actor policy.
- A new `ActorError` reason, `RunnerAtCapacity`, reports that the runner couldn't start an activation for the command, so that attempt wasn't admitted. `isRetryable` is true. Every command handle's error type includes it. Queries don't include it, because they start no activation.
- The handle retries `RunnerAtCapacity` with the same command id and the same capped exponential backoff as `ActorUnavailable`, within `deliveryTimeout`. When the timeout passes, the caller receives `RunnerAtCapacity` if an attempt was rejected at capacity and the actor has no resident activation. Otherwise it receives `Timeout`, as before. An earlier version decided this by whether an attempt was in flight, and CI showed that this depends on timing.
- The runtime maps Cluster's `MailboxFull` to `MailboxFull` only when the actor has a finite `mailboxCapacity` and its activation is resident. Each actor type's registration counts its resident activations for this check. Every other case is `RunnerAtCapacity`, so an unbounded actor can never report `MailboxFull`.
- `Database.postgres` defaults `maxConnections` to 50. An explicit value still wins.

## Alternatives

- **Evict the least recently used idle activation instead of rejecting.** Nicer for callers, but Cluster exposes no eviction hook, and eviction interacts with hibernation and with the per-activation memory growth that isn't explained yet. It can come later behind the same option.
- **Default `maxResidentActors` to unbounded or to 100,000.** Rejected for now. The heap grows by roughly 10–50 KiB per activation touched, and part of that outlives hibernation (cause unknown). A higher default would move the failure from a typed, retryable error to running out of memory.
- **Report runner capacity as `ActorUnavailable`.** It is retried the same way, but it hides a condition an operator can fix by raising the limit or adding runners.
- **Pool default of 25.** It barely changed the tail: p99 went from 1.37 s to 1.14 s on the DURA-17 runs, and from 535 ms to 495 ms on this branch's run. With 64 callers, only 50 connections removed most of the wait for a connection.
- **Pool sized to caller concurrency, for example 64 or more.** More connections than concurrent turns don't help. Postgres's default `max_connections` of 100 would then leave little headroom for a second runner or for operators.

## Consequences

- A caller over capacity now waits up to `deliveryTimeout` (30 s by default) before failing, instead of failing at once. That's intended: slots free as idle actors hibernate. A deployment that routinely exceeds the limit needs a higher limit, more memory, or more runners.
- `RunnerAtCapacity` and `Timeout` both leave an earlier attempt with the same command id possibly committed, so callers retry with the same id.
- A pool of 50 opens connections only as load needs them, and it releases idle ones after 10 seconds. A deployment with several runners must keep `runners × maxConnections` below the server's `max_connections`, or use a pooler.
- A bounded actor can still receive `MailboxFull` for a capacity rejection in one narrow window. Cluster removes a hibernating activation from its map before it closes the handler scope where the count drops. A command sent to that actor in between is rejected for capacity while the actor still counts as resident. Cluster offers no hook to close the window, and the command can be retried like any `MailboxFull`. Unbounded actors are unaffected.
- Two `Actors.layer` builds that share a layer memo map also share Cluster's `Sharding` layer, so the second build's `maxResidentActors` has no effect. The capacity conformance cases build their runtime with `Layer.fresh`. Applications build one runtime.

## Evidence and revisit conditions

- The conformance cases in `packages/durable-actors/src/testing/conformance/capacity.ts` run on PGlite and Postgres. Over-capacity load on an unbounded actor produces no `MailboxFull`. Callers either succeed after retry or receive `RunnerAtCapacity` after `deliveryTimeout`, and rejected actors have no receipt.
- `benchmarks/results/2026-09-25-281a4b3-runner-capacity-postgres.json` and its repeat record the 100,000-actor case with `maxResidentActors: 100000` and no failures, and the 10/25/50 pool sweep.
- Revisit the `maxResidentActors` default when the per-activation memory growth is explained. Revisit the pool default when turns take two round trips (#40) or when multi-runner deployment is supported.
