# ADR 0115: Warm actor commands

**Status:** implementation decision (2026-10-09, launch orchestration). Amended 2026-10-11: the committed-snapshot query cache is disabled for correctness; only warm commands remain.

**Responsibility:** remove the admission flight for eligible warm commands without weakening durable fencing or receipts. Queries always read the database.

**Authority:** design decision record.

**Owner role:** runtime architecture.

**Change policy:** supersede through a new ADR when eligibility or consistency changes.

## Context

Customer Postgres makes each database flight customer-visible latency. [ADR 0020](0020-two-round-trip-turn-pipeline.md) rejected speculative handlers and required two flights, even when the activation already held committed state and its generation. [ADR 0072](0072-served-command-in-two-round-trips.md) removed the off-turn receipt and clock reads. We now allow speculation, but not speculative publication or durable authority from memory.

Handler evaluation is not exactly-once even in the ordinary path: [ADR 0084](0084-cross-actor-group-commit.md) reruns innocent members after a shared statement failure, and a defective batch runs again one command at a time. The exactly-once guarantee concerns a retained command identity's **committed transition**, not an evaluation counter or activation-local mutation. Handlers must not perform external effects; they stage jobs for executors instead.

## Decision

### Warm command: compute first, one guarded commit flight

An eligible Postgres activation evaluates one command on a private copy of its cached committed state. The normal handler compiler still enforces state schemas, byte limits, declared-failure isolation and capability boundaries. No transaction or generation lock is held during this computation. Nothing computed is published or installed in the activation cache.

One pipelined extended-protocol flight then sends, in order:

1. `BEGIN` and transaction-local timeout/tenant settings;
2. a guard that locks the generation row and checks the expected generation, creation marker, event head, null `cold_ref`, absence of the command receipt, and external identity time bounds against the database clock **after the lock wait**;
3. every staged state, event, outbox, job, creation and receipt write;
4. `COMMIT`, followed on the same session by the fresh WAL insert position and database clock from [ADR 0052](0052-read-your-writes-commit-versions.md).

The guard raises a SQL error on a miss, aborting the transaction before any consequence. All later writes fail in the aborted transaction; PostgreSQL answers `COMMIT` with `ROLLBACK`. A receipt insert remains uniquely constrained, so a receipt committed while the guard's snapshot waited also aborts the entire transaction. Only a proven `COMMIT` tag installs the new committed snapshot and releases outcomes, broadcasts and relay notifications. Payload hashing uses PostgreSQL's JSONB normalization, exactly as ordinary admission does.

A guard miss or receipt insertion race discards speculation and the cached view, then uses ordinary fenced admission. A stale generation reloads committed state and reevaluates safely. An existing receipt resolves the original caller, command and canonical payload, then returns the stored success/failure or access/conflict error, without evaluating another handler. Other SQL errors, defects, cancellation, lock/execution timeouts and ambiguous commits use existing defect/retry recovery, not an optimistic retry loop. Commit-unknown discards the cache; redelivery uses the same id and ordinary admission. If the receipt committed, recovery evaluates no handler. If the transaction rolled back, recovery may evaluate again.

An external identity that is future or expired at the post-lock database clock cannot commit. A speculative handler may already have been evaluated, including when expiry passes during the fence wait; its work is discarded, and ordinary admission returns `InvalidCommandId(future)` or `CommandExpired` without further evaluation. Format and retry-window checks still occur before external delivery. This amends the old no-handler-on-expiry wording only for discarded speculation, not identity rejection, receipt retention or pruning safety.

### Eligibility and replay knowledge

The fast path requires a confirmed committed state, generation, creation marker, event head and database clock reading. Eligibility is conservative:

| Condition                                                                                           | Path and reason                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One command; resident confirmed state and matching generation/state pointer; unused recent identity | Speculate, then one guarded commit flight. Memory is never commit authority.                                                                                            |
| First activation, wake, missing or invalidated state                                                | Ordinary admission reloads and fences before evaluation.                                                                                                                |
| Fetched-but-unwritten cold material or non-null `cold_ref`                                          | Ordinary cold admission only. Material is not committed cache state; the fast SQL guard also rejects the pointer ([ADR 0114](0114-cold-tier-admission-and-garbage.md)). |
| Owned tables/blobs or a handler that can use `turn.rows`                                            | Ordinary admission. A database read cannot complete before its reply; SQL writes also need declared-failure savepoints.                                                 |
| SQL-dependent workflows, workflow routes, subscription deliveries/cursor checks, connections        | Ordinary admission retains the existing lock/cursor/connection protocol.                                                                                                |
| Newly staged jobs, intents or subscriptions                                                         | Discard speculation before SQL and use ordinary admission's authoritative clock for identity and due-time derivation.                                                   |
| Multiple-command batches, chained admission or an existing shared-turn member                       | Keep the ordinary two-group batching and shared-turn mechanism.                                                                                                         |
| Commit-unknown redelivery, remembered completed id, identity at or before the replay watermark      | Ordinary receipt resolution; stored outcome/access/conflict checks precede any further handler evaluation.                                                              |

The activation remembers at most 1,024 completed ids. Its watermark begins at its first fenced admission clock and advances past evicted identities. Thus eviction never makes an old duplicate eligible again. Memory is a **skip hint**, not receipt authority: replay, conflicts, caller access, expiry and pruning safety still resolve in ordinary database admission. Concurrent copies queued behind an original see its completed-id hint before they can speculate.

An unexpected, previously unseen receipt can still cause one discarded speculative evaluation, especially after ownership changes. There is no global once-only evaluation promise. Receipt access does not depend on that evaluation, and speculation cannot release a value, create a second receipt or commit business changes. Applications must not use closure mutation or external calls as an exactly-once effect.

Batches, commutative folding, same-flight successor admission and cross-actor group commits retain their ordinary two-group mechanism. A deterministic speculative defect is reported only after ordinary admission has first excluded a receipt replay; the ordinary defect path still leaves no receipt and keeps the activation resident.

### Queries: the read cache is disabled

Every query reads the database through the established replica/primary path, with the caller's `durable-min-version` rules from [ADR 0052](0052-read-your-writes-commit-versions.md). No query is answered from an activation's memory. `read.version` is therefore always undefined.

The first version of this decision let a query read the activation's committed snapshot and tag it with the post-COMMIT WAL position. Its metadata does not prove the resident state current. A global LSN read after `COMMIT` is not an applied prefix for an actor, so a successor can commit between the old owner's `COMMIT` and its version read and the older memory would carry a newer token. A read-only probe of the generation row's `xmax` after the version read does not close this: `VACUUM FREEZE` resets `xmax` to 0, and a MultiXact can reach the numeric value of the turn's xid, so a foreign writer can look like no writer. The probe and the cached metadata it certified are removed. Restoring a read cache would need independent durability, freshness and net-cost evidence, and is a separate decision.

The command snapshot (state, generation, creation marker, event head, receipts and replay watermark) stays: it is only read by the next command's speculation, whose guard locks and validates the generation row inside the commit flight, so a stale snapshot costs a discarded evaluation and never a wrong commit.

## Guarantees

| Path                                      | Database flights (no handler SQL) | Kept guarantees                                                                                                                                                                      | Evaluation / freshness limit                                    |
| ----------------------------------------- | --------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Eligible warm command                     |                                 1 | Generation fence, tenant scope, atomic consequences + unique receipt, canonical conflicts, expiry, declared-failure isolation, post-COMMIT WAL version; no publication before commit | Handler is speculative and can be discarded                     |
| Ordinary/cold/SQL/batch/group command     |                                 2 | Existing admission-before-handler ordering and all turn/receipt guarantees                                                                                                           | Handler can still repeat after rollback/group failure           |
| New jobs/intents/subscriptions            |                                 2 | Authoritative admission-clock identities and atomic obligations                                                                                                                      | Discarded speculative evaluation may precede ordinary admission |
| Known duplicate / commit-unknown recovery |                                 2 | Authorized stored outcome or conflict; same id; no second committed transition                                                                                                       | A committed receipt skips handler evaluation                    |
| Guard/receipt miss                        |  1 aborted flight + ordinary path | No effect from the discarded plan; reread durable authority                                                                                                                          | Stale state may require handler reevaluation                    |
| Any query                                 |               Existing query cost | Database snapshot of state, head and rows, access checks, replica catch-up and primary fallback for `durable-min-version`                                                            | Never answered from activation memory; `read.version` is empty  |

## Alternatives and consequences

Keeping two flights preserves admission-before-evaluation but pays the customer's network latency on every warm turn. One giant guarded CTE would require rewriting every staged write and its result decoding; a guard followed by existing pipelined statements keeps one transaction and one source of truth for consequence writes. Speculating rows reads cannot work: their values require a database reply before the handler can finish, and their writes need declared-failure savepoints. Routing every query to the activation would change placement/availability and wake behavior; queries retain the ordinary database path.

There is no migration, public turn option, protocol change or weaker `synchronous_commit`. The ordinary admission seam stays available for [ADR 0114](0114-cold-tier-admission-and-garbage.md)'s cold rehydration work. The fast guard requires null `cold_ref`, projecting through `to_jsonb(g)` until that column is introduced; fetched material cannot qualify before write-back commits. This does not implement cold rehydration.

## Evidence and revisit

Reply-loss faults pause at `beforeCommitSend`, after speculation has either produced a committable plan or fallen back to ordinary admission. `beforeCommit` can be reached by the speculative handler first. Holding all database replies there can prevent the fallback admission itself from completing, so it cannot prove commit-unknown recovery. The cluster regression `resolves a warm intent turn after a landed connection loss without pausing speculative admission` fixes seed `c774862372`: two successful payments warm the payer, then a third payment loses its commit reply. It verifies the drawn fault, all three receipts, a drained outbox and the independently expected wallet total of six without extending the recovery deadline.

`tooling/conformance/src/conformance/pipeline.ts` measures actual protocol flights on real Postgres and exercises stale-fence rollback/reload, duplicate/conflicting identities, receipt races, lost COMMIT replies, declared failures, defects, expiry after a fence wait, and reads during staged/failed commits. Its relay can hold a post-COMMIT version statement while a successor commits, `VACUUM (FREEZE)` runs before and after a public `COMMIT`, or a fresh server's MultiXact reaches the committing turn's xid: in each case a query must return the stored count with an empty `read.version`. Existing ordinary pipeline, rows, group, batching and crash cases remain required. [BENCHMARKS.md](../../BENCHMARKS.md) records before/after p50/p99 on real Postgres with injected network delay, with limits stated separately from production claims.

Revisit if missed guards, replay-hint memory or lost cross-actor grouping savings dominate the measured network benefit. Neki is not a supported backend and receives no claim from this decision.
