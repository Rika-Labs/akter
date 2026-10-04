# ADR 0071: First-come, first-served pools, a query pool, and releasing the turn session before publish

**Status:** proposed (2026-10-03, on [#492](https://github.com/Rika-Labs/akter/issues/492)). It amends [ADR 0019](0019-runner-capacity-and-pool-size.md)'s connection budget and [ADR 0020](0020-two-round-trip-turn-pipeline.md)'s pools and lease span, and composes with [ADR 0077](0077-admission-control.md)'s pool checkout bounds, whose decision 5 it extends to the query pool.

**Responsibility:** decide how a runner's Postgres pools hand out connections, which pool serves queries, and how long a turn holds its session.

**Authority:** design decision record.

**Owner role:** runtime.

**Change policy:** supersede through a new ADR.

## Context

The internal benchmark's `query-latency/concurrent-64` and `receipt-replay/concurrent-64` cases reported a maximum of about 10 seconds against a p99 of about 5 ms. Both run only on the off-turn pool of 10 connections. The external 1,000-key read with 64 callers had a p99 of 216–300 ms.

The 10 seconds was the length of the measurement window. Exactly 55 operations took a second or more in every run, which is 64 callers minus the 10 connections minus one. Effect 4.0.0's `Pool`, which `@effect/sql-pg` uses, frees a connection and then schedules the waiter it wakes. A fiber that asks in between takes the connection first, and the woken waiter queues again at the back. In a closed loop, the fiber that just freed the connection asks again at once. So the same 10 callers kept the connections, and the other 54 waited until the load stopped. A 30-line reproduction against `Pool.makeWithTTL` alone, with 64 workers on 10 items, leaves 54 workers waiting for the whole run. Effect's `Semaphore` and `Queue` wake waiters the same way. No newer Effect release changes this.

The turn pool has the same behaviour: `many-actors` reported a maximum near 9 seconds with 50 connections. Queries also shared the off-turn pool with command admission and receipt replays, so a burst of readers queued commands and the reverse. A turn kept its session leased while it published its batch.

## Decision

1. **Every runner pool hands out connections first come, first served.** A gate with one slot per connection sits in front of the turn pool, the off-turn pool, the query pool, and the optional replica and coordination pools. A slot freed while callers wait goes straight to the oldest waiter, so no caller waits behind a caller that asked after it. Because every checkout passes the gate, the pool beneath never has a waiter of its own. An interrupted waiter gives up its place, and one interrupted after it was handed a slot passes the slot on. The off-turn, query, replica, and coordination clients are one client, `boundedPool`, which is `PgClient.make`'s client built on that gate: the same pool, compiler, transforms, commit check, savepoint handling, and notification semantics. In particular, `notify` uses its own checkout rather than the caller's transaction, and rejects channel names exceeding 63 UTF-8 bytes. A single statement borrows its connection without opening a scope, as `PgClient` does.
2. **The gate sits under ADR 0077's checkout bound.** Every checkout passes three stages in this order, on one native pool: ADR 0077's bounded admission slot (connections plus 64), which refuses at once past its limit without queuing; then this gate's first-come, first-served slot; then the native pool. The bound decides whether a caller may wait at all, so the gate's waiter queue never holds more than 64 callers; the gate decides the order in which admitted callers get a connection. Neither replaces the other, and they never run side by side on separate pools. A checkout holds both slots for the connection's lifetime, in its scope or for a borrowed statement, and returns them with the connection; a statement inside a transaction reuses the transaction's connection and takes neither. The query pool is bounded the same way as the other pools ADR 0077 lists.
3. **Queries read from their own pool.** `Database.postgres` takes `queryConnections`, default 10. Queries of types without owned tables or blobs read the primary through it, and still read a caught-up replica when one is configured. Queries of types with owned tables or blobs stay on the off-turn pool, because the owned-rows binding is built on that client and must share its transaction. Command admission, receipt replays, the relay, migrations, and cluster storage stay on the off-turn pool.
4. **A turn returns its session before publishing when it chains nothing.** The session is leased per chain of pipelined batches, not per run. After a batch's commit flight is answered with no following batch queued behind it, no transaction is open and nothing is in flight, so the session goes back to the pool before the batch's callers are answered. A batch that arrives later leases a session again, through both slots, and an ADR 0077 refusal of that lease refuses only that batch, whose commands have not run. Returning the session closes the lease's scope, which releases the session and both slots together. A batch whose successor's `BEGIN` and admission ride in its commit flight keeps the session, as ADR 0020 requires.
5. **The turn pool stays at 50 connections.** A turn now holds a session only for its transaction. A turn waiting for one waits behind earlier turns only. Resizing waits for multi-runner deployment, which ADR 0019 already names as its revisit condition.

## Alternatives

- **Multiplex the off-turn pool.** With 32 statements per connection, 64 callers would never wait for a connection. But one backend runs a connection's pipelined statements one after another, so 64 readers would share two backends instead of ten, and a slow statement would hold up the 31 behind it. Starvation would come back past 320 concurrent statements.
- **Patch Effect's `Pool`.** This is the right long-term fix, and it belongs upstream. A patch in this repository would not reach applications, which install `effect` themselves as a peer dependency.
- **A larger pool.** Starvation appears whenever callers outnumber connections. A larger pool moves that point; it does not remove it.
- **Route admission reads to the query pool.** Commands would then queue behind readers again, which is what the separate pool exists to stop.

## Consequences

- **Connections.** A runner can hold `maxConnections + offTurnConnections + queryConnections` primary connections, 70 by default instead of 60. An optional coordination pool adds its `maxConnections` (default 10) on its authority server; an optional replica pool adds its own `maxConnections` (default 10) on the replica server. Count every pool pointing at each server, even when separately configured pools share that server. [Deployment](../operations/01-deployment.md#postgres-connections-across-runners) gives the new budget.
- **Latency is shared.** Under a closed loop with more callers than connections, every caller now waits its turn. The internal 64-caller cases' p50 rises from about 1 ms to about 10 ms and their p99 from about 6 ms to about 20 ms. Their throughput falls 6–7%, because a freed connection now waits for the next caller's fiber to be scheduled instead of going to the fiber that is already running. Their maximum falls from 10 s to under 50 ms.
- **Statement order on the session is unchanged.** Admission, handler statements, commit, the version read, and chained admission keep their groups and order. The fence before the handler, receipts, and exactly-once replies are untouched. A session returns to the pool only when its transaction is idle, as before.

## Evidence

Daytona, Linux x86-64, `cpu.max = 400000 100000` (4 CPUs) shared by the Postgres-and-app container and a 1-CPU driver; base, pools only (decisions 1 and 2), and all three decisions interleaved, three runs each. Medians with min–max:

| Case                                           | Base                      | Pools only             | All                    |
| ---------------------------------------------- | ------------------------- | ---------------------- | ---------------------- |
| `query-latency/concurrent-64` max              | 10,004 ms [10,003–10,007] | 27 ms [26–31]          | 44 ms [27–46]          |
| `query-latency/concurrent-64` operations ≥ 1 s | 55 [55–55]                | 0                      | 0                      |
| `receipt-replay/concurrent-64` max             | 10,007 ms [10,006–10,010] | 44 ms [33–45]          | 43 ms [37–49]          |
| 1,000-key read, 64 callers, p99                | 216 ms [203–256]          | 30 ms [30–31]          | 32 ms [32–35]          |
| 1,000-key read, 64 callers, throughput         | 3,353 op/s [3,216–3,419]  | 3,264 [3,239–3,417]    | 3,347 [3,188–3,391]    |
| Open loop 1,000/s, p99                         | 559 ms [260–1,045]        | 332 ms [183–474]       | 323 ms [283–328]       |
| Open loop 2,000/s, p99                         | 4,495 ms [4,370–4,669]    | 4,356 ms [4,187–4,418] | 4,237 ms [4,218–4,338] |

The harness, raw results, and the same comparison on a CPU-limited Docker setup on a developer Mac are kept outside the repository, as [BENCHMARKS.md](../../BENCHMARKS.md) describes. Conformance: the pipeline case "a turn that chains no batch returns its session before its callers are answered" fails on the previous lease span. The pool case "keeps every caller moving on each runtime pool when callers outnumber connections" fails on Effect's pool and semaphore.

## Revisit when

- Effect's `Pool` hands a freed item to its oldest waiter. The gate can then go.
- `@effect/sql-pg` lets a reserved connection pipeline, which merges the turn pool into the client pool (ADR 0020). The gate then moves with it.
- Multi-runner deployment is supported, so the pool defaults can be sized per runner.
