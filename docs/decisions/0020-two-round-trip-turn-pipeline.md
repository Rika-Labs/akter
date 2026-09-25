# ADR 0020: The two-round-trip turn pipeline

**Status:** proposed (2026-09-26). Dallen set the target on 2026-09-25: two SQL round trips per turn, and no one-round-trip fast path.

**Responsibility:** decide how the runtime issues a command turn in two database round trips, as [ADR 0005](0005-turn-latency-batching-and-regional-placement.md) requires, and what the implementation must prove.

**Authority:** historical decision record.

**Owner role:** runtime architecture.

**Change policy:** supersede through a new ADR when the mechanism or the round-trip target changes.

## Context

ADR 0005 decided that a turn costs two database round trips. The first, admission, carries `BEGIN`, tenant scope, the generation fence, and receipt resolution. The second, commit, carries the writes, the receipt, and `COMMIT`. It left the mechanism open. Today a warm turn takes 14 sequential round trips ([performance](../verification/03-performance.md)). The open PR #43 measured a cut to 10. Over a real network, or through a Neki router with a cross-zone commit, round trips are the cost that matters most.

The issue that opened this work (#54) assumed the runtime drives node `pg` 8.23, which it said had no pipeline mode. Both halves of that turned out wrong:

- **The runtime driver is not node `pg`.** `Database.postgres` builds `PgClient.layer` from `@effect/sql-pg` 4.0.0-rc.116, which has its own wire-protocol client. In the framework package, node `pg` is only a dev dependency, used by tests. `packages/postgres` and `examples/counter` use it at runtime, but they don't run turns.
- **Node `pg` 8.23 does pipeline.** It has `new Client({ pipeline: true })`.
- **`@effect/sql-pg` pipelines too, with a limit.** It pipelines only on a _multiplexed_ connection that isn't pinned. A transaction, meaning `SqlClient.withTransaction` or `pool.reserve`, pins its connection. Every statement on a pinned connection waits for the previous one to finish.

The spike below measured each option.

## Spike

**Setup:**

- Postgres 18.6 in Docker and PGlite 0.5.8, both driven from Bun 1.3.14.
- Drivers: `@effect/sql-pg` 4.0.0-rc.116, `@effect/sql-pglite` 4.0.0-rc.116, and node `pg` 8.23.0.
- A TCP relay added 5 ms each way and counted _flights_. A flight is one round trip the client waited for: each time the client writes after the server last wrote.
- The test turn used trimmed copies of the framework tables: `BEGIN`, `set_config` for the timeouts and tenant, the fenced read that joins the receipt (`FOR UPDATE`), one state upsert, the receipt insert, and `COMMIT`.

The scripts and raw outputs are in Floppy's drive, under `handoffs/DURA-28-turn-pipeline-spike/`. They aren't committed.

**Postgres 18.6:**

| Mechanism                                                                                                        | Driver                                                    |                                                      Flights per turn | Time at 10 ms RTT |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------: | ----------------: |
| Interactive transaction, statements awaited in turn (today's shape)                                              | `@effect/sql-pg`, pool, `multiplex` off or on             |                                                                     6 |          75–78 ms |
| Same, with statements issued concurrently inside `withTransaction`                                               | `@effect/sql-pg`, pool, `multiplex` off or on             |                                                                     6 |          74–78 ms |
| **Dedicated multiplexed connection, turn sent as two pipelined groups**                                          | `@effect/sql-pg` `PgConnection.make({ multiplex: true })` |                                                                 **2** |         **28 ms** |
| Two pipelined groups                                                                                             | node `pg`, `pipeline: true`                               |                                                                     2 |             31 ms |
| Two groups, pipelining off                                                                                       | node `pg`                                                 |                                                                     6 |             81 ms |
| Multi-statement text (`BEGIN; …; COMMIT`), no parameters                                                         | node `pg` (simple protocol)                               |                                                                     1 |             14 ms |
| Multi-statement text                                                                                             | `@effect/sql-pg`                                          | rejected: "cannot insert multiple commands into a prepared statement" |                 – |
| One guarded data-modifying CTE (fence, receipt `ON CONFLICT DO NOTHING`, and writes guarded on both), autocommit | `@effect/sql-pg`                                          |                                                                     1 |             16 ms |
| Admission read, then the guarded CTE                                                                             | `@effect/sql-pg`                                          |                                                                     2 |          27–29 ms |
| Three statements outside a transaction, issued concurrently                                                      | `@effect/sql-pg`, pool, `multiplex` off / on              |                                                                 3 / 1 |        39 / 14 ms |

**Pipelined groups fail safely.** When the fenced read raised in group 1 (stale expected generation), every statement pipelined after it in the same transaction failed with "current transaction is aborted". `COMMIT` then returned `ROLLBACK`, and no receipt was written. This held for both `@effect/sql-pg` multiplexed and node `pg` pipelined.

**The guarded CTE is correct on both backends.** On Postgres 18.6 and PGlite 0.5.8:

- a stale generation writes nothing;
- a duplicate command id writes nothing, not even the event sequence bump.

On Postgres only:

- 20 concurrent copies of the same command id admitted exactly one;
- when another connection bumped the generation while the CTE waited on the row lock, the CTE wrote nothing;
- a `lock_timeout` set inside the same statement stopped the fence wait after 303 ms.

A PL/pgSQL function installed and ran on both backends.

**PGlite 0.5.8 through `@effect/sql-pglite`, 500 turns:**

| Shape                   |            Engine calls per turn | Time per turn |
| ----------------------- | -------------------------------: | ------------: |
| Interactive transaction |                                6 |       2.09 ms |
| One guarded CTE         |                                1 |       1.03 ms |
| Multi-statement text    | rejected by `@effect/sql-pglite` |             – |

PGlite runs in-process and has no wire, so pipelining doesn't apply to it. Each statement is one call into the engine.

## Decision

### The turn is two pipelined groups on a turn-owned multiplexed connection

A turn runs as an ordinary interactive transaction on one connection that is leased to that turn alone. Its statements are sent in two pipelined groups. Each statement is its own extended-protocol cycle, with its own `Sync`, so bind parameters, prepared statements, and binary `bytea` all work unchanged. The runtime queues a group's statements in order without waiting for replies. It then waits for every reply in order and fails the turn on the first error. Postgres answers `COMMIT` in an aborted transaction with the command tag `ROLLBACK` and no error, so the runtime also checks that the `COMMIT` tag is `COMMIT`. Any other tag is a failed commit: the activation cache is discarded and the turn dies `RetryTurn`.

Queuing a group is uninterruptible, so either every statement of the group is queued or none is. The driver skips a queued statement whose waiter was interrupted before the flush and still sends the ones after it. An interruptible submission could therefore drop a state upsert and still send the receipt and `COMMIT`. Interruption is allowed only while the runtime waits for replies.

1. **Admission group (round trip 1):**
   - `BEGIN`;
   - `set_config` for `lock_timeout`, `statement_timeout`, tenant scope, and on Neki `__neki.tx_mode='single'`;
   - on a cold activation only, the generation insert-if-missing (`INSERT … ON CONFLICT DO NOTHING`);
   - the fenced read of the generation row, joined to the receipt for this command id (`SELECT … FOR UPDATE OF g`);
   - on a cold activation only, the generation bump (`UPDATE … RETURNING`) and the state read.

   None of these statements takes a parameter derived from another's reply. The insert-if-missing must come before the fenced read, as it does today. Otherwise, for a brand-new actor, the fenced read would lock no row, and receipt resolution would happen without the lock.

   An actor whose handler can issue statements adds `SAVEPOINT` for declared-failure isolation (open question 3).

2. **The handler runs in memory** once the admission replies arrive. The fence check, receipt access and conflict checks, the creation check, and state decoding all happen before the handler runs. Handler-issued `turn.rows` statements run on the same connection, and each one the handler awaits costs a round trip. They reach it through a `SqlClient` that the runtime builds around the leased connection. Its acquirer returns the unpinned connection, as `PgClient.makeClient` does, so statements pipeline. The runtime also provides that client's transaction service, so the owned-rows binding accepts it as the turn transaction. `BEGIN` and `SAVEPOINT` are sent as plain statements, never through `withTransaction`, because `withTransaction` pins.
3. **Commit group (round trip 2):**
   - `ROLLBACK TO SAVEPOINT` on a declared failure, or `RELEASE SAVEPOINT` otherwise, when a savepoint was taken;
   - dirty state upserts and deletes, event appends, outbox rows, and the creation marker;
   - the receipt insert;
   - `COMMIT`.

   Any exit other than a successful `COMMIT` sends `ROLLBACK` as round trip 2, with no writes, or closes the connection. That includes a replayed receipt, a stale generation, `NotCreated`, a conflict or access denial, a deterministic defect, a handler defect, and a failed `turn.rows` statement. A connection goes back to the lease only when its transaction is idle. Otherwise the next turn's `BEGIN` would only raise a warning, and two turns would share one transaction.

**Statement count.** A warm turn with one dirty key and no handler statements takes 2 round trips and 6 statements: `BEGIN`, config, fence, state upsert, receipt, `COMMIT`. #43's warm path takes 10 round trips. A new activation or wake also takes 2 round trips: it adds 3 statements to group 1.

**Behaviour change (internal):** today every turn wraps its handler in a savepoint (a nested `withTransaction`). Under this design only actors whose handlers can issue statements take one (open question 3).

**Why the order still holds.** The server executes a pipelined group in the order it was sent, all inside one transaction. The insert-if-missing guarantees that the row exists, so the fenced `FOR UPDATE` read always takes the generation lock before the bump or the state read runs. The receipt is resolved under that lock, and no consequence is written or exposed until the commit group. This is the order that [contract 02](../contracts/02-command-turns.md) already requires. The contract's wording change below only makes it explicit that "order" means execution order on the server, not waiting for each reply on the client.

**How the lease works.** `@effect/sql-pg` rc.116 pipelines only on a multiplexed connection that isn't pinned, and a pinned transaction serializes its statements. So the runtime keeps a second pool for turns: `PgPool.make({ multiplex: true, multiplexConcurrency: 1 })`. With a concurrency of 1, `pool.get` hands each connection to one turn at a time, the connection stays unpinned so it pipelines, and `pool.invalidate` discards it after an interrupt. The pool also brings lazy opening, TTL, and replacement of dead connections. Queries, the relay, migrations, and Cluster storage keep using the ordinary `SqlClient`. The runtime also asks Effect upstream to let a reserved connection pipeline. When that ships, the turn pool collapses back into `PgClient`'s pool.

```ts
// Runtime-internal sketch for P4. Names are illustrative.
const pipeline = (conn: PgConnection.PgConnection, statements: ReadonlyArray<Statement>) =>
  Effect.gen(function* () {
    const sent = []
    // Forking in order puts each cycle on the wire in submission order.
    // Queue the whole group or none of it; only the waits below are interruptible.
    const sent = yield* Effect.uninterruptible(
      Effect.forEach(statements, (s) => Effect.forkChild(conn.query(s.sql, s.params))),
    )
    return yield* Effect.forEach(sent, Fiber.join) // every reply, in order; first error fails
  })

const runTurn = Effect.fn(function* (request: Request, cache: ActivationCache) {
  const conn = yield* TurnConnections.lease // exclusive and multiplexed; closed, not returned, on interrupt
  const cold = cache.generation === undefined
  const replies = yield* pipeline(conn, [
    begin,
    configure(policy, request.ref.tenant),
    ...(cold ? [ensureGeneration(request)] : []),
    fenceAndReceipt(request),
    ...(cold ? [bumpGeneration(request), readState(request)] : []),
  ])
  const decided = yield* admit(replies, cold, cache) // stale fence, replay, conflict, NotCreated
  if (decided._tag !== "Run") return yield* finish(conn, [rollback], decided)
  const result = yield* runHandler(request, decided.state, conn) // turn.rows statements use `conn`
  // finish checks the COMMIT tag; any failure sends ROLLBACK or invalidates the connection
  return yield* finish(conn, [...writes(result), receipt(request, result), commit], result)
})
```

### Interruption closes and cancels the connection

`commandTimeout` interrupts the turn. On a pinned connection, interrupting sends a `CancelRequest`. On an unpinned multiplexed connection, interrupting only abandons the pending replies, and the transaction stays open. So an interrupted turn does two things:

- it sends a `CancelRequest` for the leased connection's backend, which is safe because the lease is exclusive;
- it invalidates the connection instead of returning it to the pool.

Closing the connection alone isn't enough. A backend that is busy running a statement doesn't notice a closed socket until that statement ends, because `client_connection_check_interval` is off by default. Until then it keeps holding the generation lock, for up to another `statement_timeout`.

The outcome depends on how far the turn got:

- **`COMMIT` not yet sent:** closing the session rolls the transaction back, and the statements that hadn't run never run.
- **`COMMIT` already on the wire:** the server still executes it, so the outcome is commit-unknown, as contract 02's F4 already describes. The caller's retry with the same command id resolves through the receipt, and the handler runs once.

**Behaviour change (internal):** a timed-out turn now costs a cancel request and a reconnect, instead of a cancel request alone.

### PGlite runs the same groups one statement at a time

PGlite has one in-process session and no wire. The runtime sends the same statements, in the same order and grouping, one engine call at a time. The round-trip check therefore runs on Postgres only. On PGlite the same case records the statement sequence instead, and checks two things: the sequence matches the admission, handler, and commit groups, and no statement takes a parameter derived from a reply in its own group. PGlite keeps using `withTransaction`, because it has one session and nothing to pipeline. PGlite's per-turn cost stays about 2 ms, which bounds local development only (see [ADR 0018](0018-benchmark-harness-and-results.md)).

### Turn batches (P5)

A batch keeps the same two groups:

- **Group 1:** one fenced read resolves the receipts of every command in the batch (`command_id = ANY($ids)`).
- **Handlers:** they run in delivery order.
- **Group 2:** it carries every command's writes and receipts, then `COMMIT`.

A command whose handler issues statements is wrapped in `SAVEPOINT` and `RELEASE SAVEPOINT` (or `ROLLBACK TO SAVEPOINT`). Those statements are pipelined with the command's first statement and its successor, so they add no round trips. The batch cap of 32 still bounds savepoints.

For pipelined batches, batch N+1's admission group is sent in the same flight as batch N's commit group. It comes after N's `COMMIT` and starts a new transaction on the same session. At steady state that is one flight per batch. Batch N+1's handlers run only after its own fence and receipt replies arrive, so no handler runs before its fence.

From the client's side, two turn transactions are then in flight at once. ADR 0005's "at most one turn transaction per actor in flight" still holds on the server, because one session executes them strictly one after the other. The lease must span consecutive batches of one activation, not one turn.

If N's `COMMIT` fails, the runtime rolls back N+1's transaction and restarts the activation, as the existing row "Pipelined batch N fails to commit" requires. P5 may defer same-flight admission if it turns out to complicate the lease.

**Behaviour change (narrows contract 02 and ADR 0005):** batch N+1 no longer runs in memory against batch N's staged state while N commits. Its admission statements may be sent then, but its handlers wait for its own fence and receipts. That allowance was the one remaining place where a handler ran before its fence, which is the speculation Dallen rejected.

### Pre-delivery reads stay (#43's pending cuts)

These reads happen before or after the turn, so they fall outside the two round trips:

- **Pre-delivery receipt read.** It stays. It answers replays without routing to the owner. #43 proposed dropping it only as part of the fast path, which is rejected below.
- **Expiry recheck before a reply.** It keeps its own database-clock read, as ADR 0007 requires. Reusing the admission clock stays rejected.
- **Command id minting.** It stays on the database clock. Minting without a clock read stays rejected.

### Neki

Neki's router must forward pipelined extended-protocol cycles in order, on the pinned session that `__neki.tx_mode='single'` requires. This is unverified, so pipelining on Neki stays gated until the **Neki locking and pinning** gate records it.

## Open questions and recommended defaults

These defaults stand unless review objects.

1. **Where turn connections come from.** Recommended: a second `PgPool` with `multiplex: true` and `multiplexConcurrency: 1`, sized by the existing `maxConnections`. The ordinary `SqlClient` pool serves queries, pre-delivery reads, the relay, migrations, and Cluster runner storage (which holds one connection for the layer's lifetime). It gets a new `Database.postgres` option, `offTurnConnections`, which defaults to 10. **Behaviour change:** a runner can now hold up to `maxConnections + offTurnConnections` connections (60 by default) instead of `maxConnections`. P4 amends ADR 0019's sizing and the `Database.postgres` documentation:

   ```ts
   Actors.layer({
     database: Database.postgres({ url, maxConnections: 50, offTurnConnections: 10 }),
   })
   // runner: up to 50 turn connections + 10 for off-turn work
   ```

   The alternative is to wait for upstream pipelining on reserved connections. That leaves P4 blocked on an Effect release.

2. **How statements are kept in order.** Recommended: fork each query in submission order, uninterruptibly, on the leased connection, as the sketch above does. A conformance case asserts the order. If upstream later adds a batch API such as `conn.pipeline([...])`, the runtime switches to it.
3. **When to take a savepoint.** Recommended: only for actors whose handlers can issue statements, meaning they declare `tables` or write blobs. State, events, and outbox rows are staged in memory, and a declared failure discards them without SQL. Any other actor never sends `SAVEPOINT`:

   ```ts
   const admissionGroup = [
     begin,
     configure(policy, tenant),
     fenceAndReceipt(request),
     ...(issuesStatements(definition) ? [savepoint("handler")] : []),
   ]
   ```

## Considered and rejected

- **The optimistic one-round-trip fast path.** For a warm activation, the handler would run first. One round trip would then carry the fence check against the expected generation, the receipt insert `ON CONFLICT DO NOTHING`, writes guarded on both, and `COMMIT`, with a fallback to two round trips on a miss. The spike shows the guarded statement is correct on Postgres and PGlite and takes one flight. Dallen rejected it on 2026-09-25 because it breaks two things:
  - **It reorders the turn.** It reverses contract 02's order, which puts the fence and receipt before the handler.
  - **It runs handlers speculatively.** On a fence or receipt miss, the handler would run and its result would be thrown away. That touches:
    - contract 04, "without running the handler";
    - invariant R2, "no handler run";
    - contract 09, reply loss resolves "without re-running the handler";
    - contract 10, replay authorization doesn't depend on rerunning the handler;
    - the failure-matrix row "After COMMIT / before reply".

  Two round trips are the target. This supersedes nothing in ADR 0005, which had already rejected a one-round-trip turn. No contract changes for it, no `policy.turns` option, and P7 isn't built.

- **Multi-statement simple-query text.** It works on node `pg` in one flight, but it has no bind parameters. Every value, including compressed `bytea` state, would have to be escaped into SQL text. `@effect/sql-pg` and `@effect/sql-pglite` both reject it outright.
- **One CTE statement per round trip.** A data-modifying CTE can't open a transaction that the handler then runs inside. Round trip 1 would still need a separate `BEGIN`, so it only reaches two round trips with pipelining anyway. It also can't touch the same row twice or run handler-issued statements between its parts.
- **A server-side function installed by migration.** It has the same `BEGIN` problem. On top of that, each turn's write set varies (dirty keys, events, outbox rows, the creation marker), which a function could only take as `jsonb` arrays. Every change to the write path would then need a migration.
- **Switching the runtime to node `pg` in pipeline mode.** It measured 2 flights. But it would add a second Postgres driver under `@effect/sql` beside the one `Database.postgres` already uses, and it gives nothing the Effect driver lacks.

## Contract changes

- **[Contract 02](../contracts/02-command-turns.md), clarification:** "order" means execution order within the transaction. A runtime may pipeline statements whose order the server preserves. A runtime that pipelines must cancel and close an interrupted turn's connection, and must treat a `COMMIT` already sent as commit-unknown.
- **[Contract 02](../contracts/02-command-turns.md), narrowed:** the next batch may send its admission statements while the previous batch commits. Its handlers must not run until its own fence and receipts are validated. This replaces "the next batch MAY execute in memory while the previous batch commits", from ADR 0005.
- **[Contract 03](../contracts/03-transactions.md), clarification:** an adapter that pipelines must prove two things. The server runs pipelined statements in submission order inside the transaction. And a failed statement aborts everything pipelined after it, so `COMMIT` rolls back.
- **Unchanged:** contracts 01, 04, 09, and 10, and invariant R2. The handler still runs only after the fence and the receipt.
- **For P5 to revisit:** the ledger check **Pipelined batches** and invariant B1 still hold as written, but with the narrowed allowance, batch N+1 has no staged work to hide until N's commit reply arrives.

The contract text cites this ADR while it is still proposed. The clarifications apply only to a runtime that pipelines, which none does yet. The narrowed batch allowance constrains P5, which doesn't exist yet. If review rejects this ADR, the contract edits are reverted along with it.

## Verification the implementation (P4) must add

**Ledger check: "Two-round-trip turns and state cache".** It's updated in [conformance](../verification/01-conformance.md). The implementing unit adds these cases to `conformance/pipeline.ts`:

- `warm turn takes two round trips` (Postgres, through a counting TCP relay);
- `wake takes two round trips` (Postgres);
- `each awaited turn.rows statement adds one round trip` (Postgres);
- `turn statements keep their groups` (PGlite and Postgres);
- `stale fence sends no writes and rolls back` (Postgres, with another runner bumping the generation);
- `first command for a brand-new actor raced by two runners runs the handler once` (Postgres);
- `a failed statement in the commit group makes COMMIT roll back and the turn fails with the cache discarded` (Postgres);
- `interrupt before COMMIT is sent cancels, closes the connection, and rolls back` (Postgres);
- `interrupt after COMMIT is on the wire resolves through the receipt and runs the handler once` (Postgres);
- `interrupt while a group is being queued sends all of it or none of it` (Postgres);
- `after a defect the next turn on the same connection starts a fresh transaction` (Postgres);
- `turn.rows statements run on the turn connection inside the transaction` (PGlite and Postgres);
- `declared failure without a savepoint discards staged state, events, and outbox rows` (PGlite and Postgres);
- `replayed receipt sends rollback only` (PGlite and Postgres).

**New failure-matrix rows**, in [failure matrix](../verification/02-failure-matrix.md):

- "Statement fails inside a pipelined commit group";
- "Turn interrupted with a pipeline in flight".

**Unchanged:** every existing crash case must stay green. The T2 statement baseline is updated in the same PR. `hot-actor` and `cold-activation` report round trips.

## Consequences

- **Runner connections.** A runner holds two pools: the turn pool, sized by `maxConnections` (default 50, from [ADR 0019](0019-runner-capacity-and-pool-size.md)), and the off-turn pool, sized by `offTurnConnections` (default 10). P4 documents the total in [deployment](../operations/01-deployment.md). The two pools merge once the upstream change lands.
- **Handler statements.** A turn's latency still grows by one round trip for each handler statement it awaits. The two-round-trip figure is for turns that issue none.
- **Transaction time.** Postgres holds each transaction for about one round trip plus handler time, instead of one round trip per statement. The generation row lock is held for about the same span.

## Revisit when

- `@effect/sql-pg` lets a reserved connection pipeline; the turn pool then merges into the client pool.
- Neki's router is tested with pipelined sessions.
- Benchmarks show the admission round trip dominates latency even with pipelining. A one-round-trip design would then need a new ADR, and Dallen's rejection above would have to be revisited.
