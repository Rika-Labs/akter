# ADR 0084: Cross-actor group commit

**Status:** implementation decision (2026-10-04), for [#495](https://github.com/Rika-Labs/akter/issues/495); amends [ADR 0005](0005-turn-latency-batching-and-regional-placement.md)'s one-transaction-per-actor batch, [ADR 0020](0020-two-round-trip-turn-pipeline.md)'s turn-owned session and [ADR 0071](0071-fair-pools-query-pool-and-early-turn-release.md)'s per-turn lease, and composes with [ADR 0072](0072-served-command-in-two-round-trips.md) and [ADR 0077](0077-admission-control.md).

**Responsibility:** let warm turns of different actors share one transaction, one `COMMIT` and one WAL flush, without letting one turn's outcome depend on another's.

**Authority:** design decision record.

**Owner role:** runtime and performance.

**Change policy:** supersede through a new ADR.

## Context

ADR 0005 merges only commands already waiting for the same actor. A workload spread over many actors therefore pays a whole transaction per command: a turn-pool lease through the bounded and fair gates, `BEGIN`, the timeout `set_config`, the fenced read, the writes, `COMMIT`, a commit flush and the version and clock read. A warm one-key command is seven statements in two flights ([ADR 0072](0072-served-command-in-two-round-trips.md)), three of which exist only to open and close the transaction.

The 64-caller, 10,000-key Daytona measurement after #552, #561, #551 and #575 serves about 1,030 commands/s. The single Bun process uses about 1.13 ms of CPU per command and Postgres about 0.45 ms, and Postgres backends sit idle in a transaction 15–19% of the time. Every per-transaction statement and lease the runner can drop is runner CPU.

Postgres cannot merge transactions that run on different sessions. A shared commit therefore means turns of different actors sending their statements on one session, inside one transaction.

## Decision

1. **Turn groups.** On Postgres, a runner keeps at most one _forming_ group per transaction setting: the `lock_timeout`, `statement_timeout` and tenant role or tenant settings a turn would `set_config`. A group leases one turn session through the same bounded and first-come, first-served lease a turn uses, and opens it with `BEGIN` and the settings, once. An eligible batch joins the forming group for its settings, or opens one when there is none. It sends its fenced admission read on the group's session, waits for its own reply, runs its handlers in memory, and hands its commit writes to the group without sending them.
2. **Who may join.** A batch joins a group only when its activation is warm (cached generation and state), its handlers can issue no SQL (no owned tables or blobs), and no workflow waits on an event it can emit. Only the first batch of a run joins; a batch that was already waiting behind another batch of the same actor uses its own session with ADR 0020's chained admission, so a hot actor keeps one flight per batch. A group never takes a lone command's place: a group of one is the same seven statements and two flights as a turn on its own session. Cold activations, handlers with SQL, PGlite and isolation retries after a non-group failure run as before.
3. **Closing and committing.** A group stops admitting members when its first member hands over its writes, when every member has left, or when it holds 32 members. It commits once every member has handed over or left. One flight carries every member's writes in join order, then `COMMIT` (`ROLLBACK` when no member wrote), then the version and clock read of ADR 0072, which therefore follows the group's commit record. A member is answered only after the `COMMIT` tag proves the commit, with `synchronous_commit` unchanged, so no reply, receipt, broadcast or intent is visible before the shared commit is durable. A member still running 100 ms after the group closed is evicted: the group commits without it and the member reruns alone.
4. **Isolation without savepoints.** A warm member's admission read writes nothing: it takes the generation row lock and reads receipts. A member that ends without writes therefore leaves nothing durable in the transaction, and its neighbours commit unaffected. Its generation row lock is the one thing it leaves: Postgres keeps a row lock until the transaction ends, so a departed member's lock lasts until the group commits, and its own retry waits for that commit. This covers a stale generation, a defect, a declared failure (whose failure receipt is itself the member's write), an expired id, a refused command, a replay and an interruption before the commit flight is sent. A member's connection accepts statements only while it sends its admission and while the group sends the commit flight; any other statement, such as a workflow re-arm discovered at run time, ends the member's place and it reruns alone, so nothing a member sends outside its writes can commit through the group.
5. **A statement error.** Any statement error aborts the Postgres transaction, and a savepoint cannot help: it needs a `ROLLBACK TO` round trip before `COMMIT`, and `COMMIT` in an aborted transaction answers `ROLLBACK`. So the member whose own statement failed, with any SQLSTATE other than `25P02` (in failed transaction), fails as it does today. Every other member reruns alone: a new transaction on its own session, its handlers run again on its unchanged cached state, which is the same isolation step ADR 0005 already takes after a batch defect. No member's outcome, receipt or reply depends on a neighbour's failure; the cost of a neighbour's statement error is one rerun.
6. **Locks.** A group's fenced read uses `FOR UPDATE SKIP LOCKED`, so a member whose generation row another transaction holds neither waits on the shared session nor aborts it; it reruns alone and waits there under its own `lock_timeout`. A member's writes touch only its own actor's rows, so groups do not wait for each other. A host usage-accounting hook that updates shared rows can still make two groups wait on each other; Postgres then aborts one, whose members rerun alone.
7. **Interruption and loss.** A member interrupted before the group sends the commit flight is withdrawn and its writes are never sent: it is absent and dies `RetryTurn` as today. Once the flight is sent, its outcome is commit-unknown and resolves through its receipt, as it already does once `COMMIT` is sent. An interrupted member never takes the group's session for its next batch: the group discards the session with that batch's chained transaction instead, and a member whose scope already closed refuses the hand-off the same way. A member's interruption never cancels the group's backend while a neighbour still waits on the commit. When every member waiting on a sent commit was interrupted, as a drain deadline does, the group cancels its backend and discards the session, exactly as a lone turn's interruption does; the outcome stays commit-unknown and resolves through the receipts. The group's own interruption, at runtime shutdown, also discards the session. A lost connection or process crash before the `COMMIT` reply leaves every member absent or every member committed, and each retry resolves through its receipt.
8. **Sessions.** The group returns its session once the commit flight's replies are in and nothing is in flight, before its members publish, as ADR 0071 requires of a turn. A refused lease refuses every member of the group before anything of theirs ran, with ADR 0077's overload refusal.

A member's cost is its admission read plus its writes: three statements for a one-key command. The group adds `BEGIN`, `set_config`, `COMMIT` and the version read once, so a group of _k_ such members sends 3_k_ + 4 statements instead of 7_k_, and leases one session instead of _k_.

## Contract

[Command turns](../contracts/02-command-turns.md) now permits warm turns of different actors to share a framework transaction under these rules. Each turn keeps its fence, receipt, replay, expiry, `NotCreated`, declared-failure and defect semantics; each turn's writes commit together or not at all; and a turn is answered only after the shared commit is proven.

## Alternatives

- **Savepoint per member.** Rolls back a failing member's statement only if `ROLLBACK TO SAVEPOINT` is sent before `COMMIT`, which costs a flight per group on every commit to recover from errors that do not occur in a warm member's own statements. With nested savepoints a later member's failure would also roll back earlier members unless every member is strictly serialized on the session. It adds two statements per member.
- **Re-fence and reuse the handler result.** An evicted or innocent member could lock its generation again in a new transaction and write the result it already computed. Its handler would then have run under another transaction's fence, which the contract does not allow.
- **One transaction per runner tick with sorted locks.** Waiting for a tick delays a lone command, which ADR 0005 forbids. A forming group that commits as soon as its members are done needs no tick.
- **`commit_delay` and `commit_siblings`.** These are server settings the runtime does not own. Concurrent commits already share WAL flushes; they do not remove the per-transaction statements or leases.
- **Two-phase commit.** `PREPARE TRANSACTION` flushes WAL for every participant.

## Evidence

On the #529 Daytona harness (three ordered repeats against `main` `b8aa892d7`), 64 callers over 10,000 keys served 1,453 commands/s against 1,075 (median), with p99 108 ms against 124 ms; 256 callers admitted 1,222/s against 956/s with a smaller refused share (36.6% against 39.1%) and admitted p99 145 ms against 162 ms. App CPU per command fell from 1.15 to 0.87 ms and Postgres CPU from 0.47 to 0.21 ms; shared commits averaged about 24 commands. Sequential commands form groups of one and stayed within noise.

The `groups` conformance cases, two pipeline cases and two crash drills reject an implementation that commits a failed, fenced, interrupted or evicted member's writes, aborts a neighbour on a declared failure or defect, fails an innocent member on a neighbour's statement error, answers before the shared commit, or leaves any member partly committed after a crash before or during `COMMIT`. Details, ranges and the single WAL-segment stall outlier are in [BENCHMARKS.md](../../BENCHMARKS.md#cross-actor-group-commit-495).

## Revisit when

- Multi-runner deployments route one actor's commands through several runners, so a group's members can contend for the same generation rows.
- `@effect/sql-pg` lets one session run independent transactions in a pipeline, or Postgres adds autonomous subtransactions.
