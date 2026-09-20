# Durable scheduling

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

The public Scheduler represents future **messages**, not serialized functions. An actor turn writes a named schedule intention into its local outbox. After commit, the runtime creates a durable delayed-delivery record in PostgreSQL/Effect Cluster. Both steps are recoverable; there is no atomic transaction spanning SQLite and PostgreSQL.

## Identity and revisions

Each schedule has an actor-scoped stable name, revision, due time in UTC, message protocol version, payload and generation. Replacing a schedule increments its revision. A late delivery with an older revision must not execute an obsolete business action. Cancelling after dispatch is a race: the receiver rechecks schedule revision and current domain state.

## Time semantics

Use Effect Clock/DateTime for calculations and testing. Persist the resolved instant. `Schedule` describes an in-process retry/repetition policy; it is not by itself durable. Recurrence must persist its rule/timezone and missed-run policy. Define daylight-saving behavior and whether a missed interval coalesces, skips or catches up. Start V1 with one-shot `at`/`after`; recurrence can be a later explicit API.

## Delivery contract

Not-before time, at-least-once delivery, bounded lateness under healthy capacity. Never promise exact wall-clock execution. Duplicate deliveries are handled by stable schedule occurrence IDs plus actor command receipts. If the actor is suspended/deleted, apply a specified dead-letter/cancel policy.

## Operational constraints

A timer should not keep a Scope/fiber alive for days. Runtime workers maintain due indexes and wake relevant actors. Backlog, oldest overdue timer, retry count and lease ownership are observable. Timer creation quota and per-tenant dispatch limits prevent a tenant from flooding the control DB.

## Tests

Crash after source schedule intent, crash after delayed message acceptance, cancellation/replacement race, late delivery after actor deletion, clock skew, duplicate occurrence, target schema upgrade, and a large overdue batch after outage.

## Sources and evidence

- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [E10: Effect v4 API index](https://effect.website/docs/v4/api/effect) — Module availability and unstable import paths. Supplied user export also inspected.
- [E05: Workflow Activity](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/workflow/Activity.ts) — Activity requires WorkflowEngine/WorkflowInstance. Only completed activity results memoized; replay can repeat external effects.
