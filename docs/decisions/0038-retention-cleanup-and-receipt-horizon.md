# ADR 0038: Retention cleanup and the receipt horizon

**Status:** implementation decision (2026-09-26).

**Responsibility:** specify how receipts and events are pruned without letting an expired command run again or a replay skip events.
**Authority:** design.
**Owner role:** runtime/reliability.
**Change policy:** supersede through an ADR when the horizon, the pruning shape, or the admission rule changes.

## Context

[ADR 0004](0004-receipt-access-revocation-and-expiry.md) requires finite retry and retention horizons, and [ADR 0007](0007-foundation-command-protocol.md) shipped v1 command ids whose issue and expiry times are part of the id, with no automatic cleanup. [Contract 04](../contracts/04-receipts.md) and [retention](../operations/retention.md) require that cleanup never lets an expired id execute anew, never removes deduplication evidence that pending work needs, and never races admission into a second execution. [Contract 05](../contracts/05-messaging.md) requires that pruning never reissues an event cursor. M1.9 (#17) adds `policy.keepReceipts` and `policy.keepEvents`.

## Decision

### The horizons

`keepReceipts` (default 7 days) is measured from the command id's issue time; a timer's receipt counts from its due time. The receipt table stores only the expiry, and every id expires exactly one retry window after its issue (a timer's intent id one window after its due time), so a receipt is prunable when `expires_at_ms <= now − max(keepReceipts − retryWindow, deliveryTimeout)`. A receipt therefore never goes sooner than `deliveryTimeout` after its id expires, whatever `keepReceipts` says; that grace keeps the admission rule below from refusing a command admitted just before expiry when `keepReceipts` is shorter than the retry window. `keepEvents` (default 30 days) is measured from each event's emit time.

Both are per actor type and apply to every tenant. Neither is a guarantee to retain data longer: an operator who needs a longer audit trail raises the horizon.

### What cleanup keeps

- A receipt whose id matches any `actor_outbox` row. The row's intent or effect route can still be delivered with that id, and internal delivery skips the expiry check, so the receipt is the only thing that makes redelivery a replay. An outbox row with an id exists before any receipt for that id, so once the row is gone no new one appears.
- Every dead letter. Their retention is operator-driven and out of scope here.
- `actor_generations.event_sequence`, which is never touched, so a sequence is never reissued after pruning.

### How it deletes

Every runtime sweeps once a minute (`ActorTest` runtimes only when a test calls `cleanup`). For each registered actor type, a sweep deletes receipts in batches of 1,000 rows (`FOR UPDATE SKIP LOCKED`, so concurrent runners do not wait on each other), then events in batches. An event batch picks up to 1,000 events past the horizon and deletes, per actor, every event up to the newest one it picked, so what remains of each stream is always a suffix even if a clock step gave a later event an older timestamp. Each batch is one transaction that first takes a per-actor-type advisory lock, so two runners, or a periodic and an explicit sweep, take turns instead of locking overlapping event prefixes in opposite orders (the first full benchmark run deadlocked without it). An interrupted sweep leaves only whole batches and the next sweep resumes. The sweep yields between batches, so a turn waiting for PGlite's single connection runs between them.

Migration `0010_retention` adds `actor_receipts (actor_type, expires_at_ms)`, `actor_events (actor_type, emitted_at_ms)`, and `actor_outbox (intent_id)`, so each batch is an index range read and the outbox check an index probe.

### Admission after pruning

External admission already rejects an expired id from the id alone, so a missing receipt never makes an expired id new. One window remains: a retry that passed its expiry check while an earlier attempt with the same id was still in flight, and whose turn runs only after that attempt committed and cleanup pruned its receipt. For that case an externally admitted turn that finds no receipt refuses the command with `CommandExpired` once the database clock has passed `expiresAt + max(keepReceipts − retryWindow, deliveryTimeout)`, the earliest moment its receipt could have been pruned. Before that moment an admitted command still runs past its expiry, as ADR 0007 requires; internal deliveries are never refused. The check reads the clock in the admission statement, so it adds no statement.

### Test clock

`ActorTest.advance` now moves one framework clock that mints and checks command ids, schedules timers, stamps events, and computes retention cutoffs. Moving only the timer clock would make cleanup prune receipts whose ids the admission clock still considered live.

### Query statement timeout

Queries read on the pool outside a transaction, so no `statement_timeout` applies. A query is now bounded by its actor type's `commandTimeout`: past it the query fails `Timeout`, and interrupting the read makes `@effect/sql-pg` send a `CancelRequest`, which stops the statement on the server. PGlite cannot cancel a running statement; the query still fails at the deadline.

## Alternatives

- Tombstones or a separate expiry table: unnecessary, because v1 ids carry their expiry and admission checks it without a receipt.
- Locking each actor's generation row while pruning its receipts: it would serialize cleanup with turns but not close the in-flight retry window, which spans a whole queued delivery, and it would block hot actors.
- Deleting events by timestamp alone: a clock step back could leave a gap in the middle of a stream, which replay's gap check cannot see.
- A transaction with `SET LOCAL statement_timeout` around every query: two more statements and round trips on every query, where cancelling on interruption costs none.

## Consequences and evidence

`conformance/retention.ts` runs on PGlite and Postgres: receipt pruning with restart, the outbox-dedup case with a crashed and paused relay, prefix pruning with a skewed timestamp and in batches, and paged replay, the emit budget and the blob quota. On Postgres only: the retry admitted before expiry whose receipt is pruned before its turn (it runs the handler twice without the admission rule), and the query cancelled on the server. `conformance/crash/retention.test.ts` kills a process inside a sweep and checks that a fresh process finishes it. The `retention` benchmark records sweep throughput and turn latency during a sweep.

Each process applies its own policy values, so a rolling deploy that lowers `keepReceipts` can briefly let a new process prune a receipt an old process's turn still relies on; [retention](../operations/retention.md) says how to lower it safely, and version skew stays an M4 item. If P4 ([ADR 0020](0020-two-round-trip-turn-pipeline.md)) moves query reads onto a multiplexed connection, interruption no longer cancels them, and the query deadline needs `statement_timeout` instead. Restore and clock rollback across pruned history remain unsupported, as ADR 0007 states.

## Revisit when

- Multi-runner relays can redeliver a row after another runner deleted it (M2.4).
- A tenant needs its own horizons, or dead letters need automatic retention.
- Restore support lands (M4).
