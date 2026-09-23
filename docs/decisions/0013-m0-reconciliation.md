# ADR 0013: Reconcile the shipped M0 code with ADRs 0010–0012

**Status:** implementation decision (2026-09-23); evidence is recorded in [conformance](../verification/01-conformance.md#foundation-evidence).

**Responsibility:** record how the M0 implementation was changed to match the accepted API and delivery decisions, and what remains unimplemented.

**Authority:** design.

**Owner role:** runtime architecture.

**Change policy:** supersede through an ADR when persisted identities, delivery, or the public API change.

## Context

M0 shipped (PR #7) before [ADR 0010](0010-one-way-effect-native-api.md), [ADR 0011](0011-direct-commands-outbox-and-performance.md), and [ADR 0012](0012-workflows-internals-effects-defects-merging-regions.md) were accepted. Its code used the older `Actor.make` option bag, `(ctx, input)` handlers, lifecycle combinators, `Actors.mint`, `get` options, an `onDefect` hook, and persisted Cluster command messages. The owner asked for the shipped work to be reconciled with the new decisions rather than migrated later.

## Decision

The M0 framework, tests, and counter example now use the target design for every feature M0 implements:

| Area              | Before (ADR 0007/0008)                                                           | Now                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Definition        | `Actor.make(name, { commands, internal: [], id, singleton, lifecycle })`         | `Actor.make(name, { key, state, api, internal, policy })`; `api`/`internal` keys must equal tags in types and at runtime                 |
| Identity          | `X.id`, `Actors.mint(X)`, `X.create()`                                           | `X.create()` only; `key: Actor.singleton` replaces `singleton: true`                                                                     |
| Policies          | `Commands`, `Delivery`, `State`, `Hibernate`, `Mailbox`, `Lifecycle` combinators | `policy` object with the same defaults and bounds                                                                                        |
| Handlers          | `toLayer(handlers, { hooks })` with `(ctx, input)`                               | `toLayer(Effect)` with `(input)`; context through a per-actor `X.Turn` service                                                           |
| Caller and tenant | `get(id, { as, tenant })`                                                        | `Actor.as(caller)` and `Actor.tenant(tenant)` around the Effect; `get` takes no options                                                  |
| Defects           | `onDefect` hook with `WakeContext`                                               | no user code; `Deterministic actor defect` log with actor, id, tenant, command, and command id inside `durable-actors.<Actor>/<Command>` |
| Delivery          | persisted `cluster_messages`; recovery redelivers stored envelopes               | volatile Cluster messages and `MessageStorage.layerNoop`; the receipt is the only durable record; the handle retries the same id         |

Direct delivery keeps every accepted-work guarantee through the receipt: a committed command replays, and an uncommitted command leaves nothing behind for its caller to retry. The handle retries `ActorUnavailable` with capped exponential backoff (10 ms doubling to 500 ms) until `policy.deliveryTimeout`.

`ActorTest` adds a `beforeDelivery` fault point between admission and delivery. With no message table, a test that must observe an admitted but undelivered command pauses there.

The SIGKILL recovery test now saves one command id, kills the process at `beforeCommit` or `afterCommit`, and has a fresh process retry that id. The first kill leaves no receipt; the second leaves one. Both recover to exactly one transition, and no `cluster_messages` table exists.

## Not implemented

The following remain target design only: reducers, queries, streams, connections, workflows and the framework `WorkflowEngine`, events, effects and effect routes, tables, blobs, `Intent`, `Fleet`, the actor outbox, placement and `routing_key`, and the two-round-trip and pipelined turn paths.

## Alternatives

- **Keep M0 on the old API until M1:** rejected by the owner; it would leave two API shapes and a delivery model the ADRs had removed.
- **Keep persisted Cluster messages for M0 only:** rejected; recovery semantics and tests would change again in M1.

## Consequences

- **Superseded M0 surface:** ADR 0008's `Actor.make` options, lifecycle combinators, `Actors.mint`, `get` options, and `onDefect` hook, plus ADR 0007's persisted Cluster envelopes, are superseded for the implementation. Their protocol, receipt, expiry, and authorization rules are unchanged.
- **Renamed conformance cases:** cases that asserted redelivery from stored envelopes are renamed and now assert caller retry and receipt replay; see the [conformance ledger](../verification/01-conformance.md#foundation-evidence).
- **No data migration:** existing databases need none, because the framework never created Cluster message tables through its own migrations.

## Revisit when

- Multi-runner operation shows caller retry after runner loss produces unacceptable tail latency.
- M1 implements the outbox, at which point durable intents need their own crash evidence.
