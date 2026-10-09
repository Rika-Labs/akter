# ADR 0115: Warm actor commands and committed reads

**Status:** implementation decision (2026-10-09, launch orchestration).

**Responsibility:** remove the admission flight for eligible warm commands and the database read for eligible local queries without weakening durable fencing or receipts.

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
4. `COMMIT`, followed on the same session by the fresh WAL insert position and database clock from [ADR 0052](0052-read-your-writes-commit-versions.md), then a read-only snapshot-provenance probe.

The guard raises a SQL error on a miss, aborting the transaction before any consequence. All later writes fail in the aborted transaction; PostgreSQL answers `COMMIT` with `ROLLBACK`. A receipt insert remains uniquely constrained, so a receipt committed while the guard's snapshot waited also aborts the entire transaction. Only a proven `COMMIT` tag installs the new committed snapshot and releases outcomes, broadcasts and relay notifications. Payload hashing uses PostgreSQL's JSONB normalization, exactly as ordinary admission does.

A guard miss or receipt insertion race discards speculation and the cached view, then uses ordinary fenced admission. A stale generation reloads committed state and reevaluates safely. An existing receipt resolves the original caller, command and canonical payload, then returns the stored success/failure or access/conflict error, without evaluating another handler. Other SQL errors, defects, cancellation, lock/execution timeouts and ambiguous commits use existing defect/retry recovery, not an optimistic retry loop. Commit-unknown discards the cache; redelivery uses the same id and ordinary admission. If the receipt committed, recovery evaluates no handler. If the transaction rolled back, recovery may evaluate again.

### Eligibility and replay knowledge

The fast path requires a confirmed committed state, generation, creation marker, event head and post-commit version. Eligibility is conservative:

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

### Warm `X.Read`: committed snapshot, no SQL

A query on a runner that already has the activation may use its immutable committed snapshot: encoded state, event head and matching post-commit WAL version. `read.version` identifies that snapshot. No activation, fence, receipt or command id is created. Authorization runs before and after the handler as before. This answers a state-only query in zero database flights; application authorization/services or configured usage accounting can still issue their own SQL.

The cache may answer a version-qualified query only when its version is at least `durable-min-version` **and its provenance is certified**. Otherwise the entire query follows the existing replica catch-up/primary path. A cold/missing/invalidated snapshot also follows that path. Database-dependent reads (`events`, `rows`, `group`, blobs) use the ordinary database query path, never a mixture of speculative state and stored rows. Query-only runners and another runner that does not hold the activation read the database normally.

A post-COMMIT global LSN is a replica replay barrier, not proof that an actor cache applied a WAL prefix. A successor may commit after the old owner's COMMIT but before its version read, tagging older state with a newer token. Admission therefore records the turn xid in a session setting; after the version read, a separate statement checks the generation, creation marker, head, null cold pointer and the generation row's `xmax`. The row must remain unlocked or carry only this turn's xid. A foreign writer changes `xmax` before inserting its commit record, including while its changes are not yet snapshot-visible. The probe is read-only, requires no row lock, xid, second durable commit or extra flight. An uncertain probe leaves the snapshot uncertified; it may answer tokenless reads, never a minimum-version query. Shared group commits conservatively leave certification unset. Ordinary single-actor commit flights use the same probe; PGlite's single-session committed state needs no concurrent-owner probe.

This proof depends on the existing rule that every writer of actor data locks its generation row. A mere snapshot-visible generation check would miss a commit record inserted before the writer's state becomes visible. The version read and probe must remain separate statements, in that order and before any chained admission.

This is a **committed, version-qualified snapshot**, not a fresh database fence or globally latest read. An undetected stale owner may return an older committed snapshot to a tokenless caller; a caller carrying a newer version cannot receive it. A pending turn, declared failure, rolled-back statement or commit-unknown result never enters the published snapshot. A captured snapshot remains stable while a concurrent command commits. Hibernation/restart removes access to it. Read-your-writes is unchanged; tokenless reads were already allowed to lag on replicas.

## Guarantees

| Path                                                  | Database flights (no handler SQL) | Kept guarantees                                                                                                                                                                      | Evaluation / freshness limit                                    |
| ----------------------------------------------------- | --------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Eligible warm command                                 |                                 1 | Generation fence, tenant scope, atomic consequences + unique receipt, canonical conflicts, expiry, declared-failure isolation, post-COMMIT WAL version; no publication before commit | Handler is speculative and can be discarded                     |
| Ordinary/cold/SQL/batch/group command                 |                                 2 | Existing admission-before-handler ordering and all turn/receipt guarantees                                                                                                           | Handler can still repeat after rollback/group failure           |
| New jobs/intents/subscriptions                        |                                 2 | Authoritative admission-clock identities and atomic obligations                                                                                                                      | Discarded speculative evaluation may precede ordinary admission |
| Known duplicate / commit-unknown recovery             |                                 2 | Authorized stored outcome or conflict; same id; no second committed transition                                                                                                       | A committed receipt skips handler evaluation                    |
| Guard/receipt miss                                    |  1 aborted flight + ordinary path | No effect from the discarded plan; reread durable authority                                                                                                                          | Stale state may require handler reevaluation                    |
| Local warm state read                                 |                                 0 | Committed state/head/version, access checks, certified minimum-version/read-your-writes                                                                                              | Not globally latest; uncertified snapshots are tokenless-only   |
| Cold, database-dependent or version-insufficient read |               Existing query cost | Existing database snapshot and replica/primary rules                                                                                                                                 | Additional SQL is not a zero-flight read                        |

## Alternatives and consequences

Keeping two flights preserves admission-before-evaluation but pays the customer's network latency on every warm turn. One giant guarded CTE would require rewriting every staged write and its result decoding; a guard followed by existing pipelined statements keeps one transaction and one source of truth for consequence writes. Speculating rows reads cannot work: their values require a database reply before the handler can finish, and their writes need declared-failure savepoints. Routing every query to the activation would change placement/availability and wake behavior; this decision uses only an already resident local snapshot.

There is no migration, public turn option, protocol change or weaker `synchronous_commit`. The ordinary admission seam stays available for [ADR 0114](0114-cold-tier-admission-and-garbage.md)'s cold rehydration work. The fast guard requires null `cold_ref`, projecting through `to_jsonb(g)` until that column is introduced; fetched material cannot qualify before write-back commits. This does not implement cold rehydration.

## Evidence and revisit

`tooling/conformance/src/conformance/pipeline.ts` measures actual protocol flights on real Postgres and exercises stale-fence rollback/reload, duplicate/conflicting identities, receipt races, lost COMMIT replies, declared failures, defects, expiry after a fence wait, and reads during staged/failed commits. Its relay can hold a post-COMMIT version statement until a successor commits: the older activation's higher token must not qualify its cache for read-your-writes. Existing ordinary pipeline, rows, group, batching and crash cases remain required. [BENCHMARKS.md](../../BENCHMARKS.md) records before/after p50/p99 on real Postgres with injected network delay, with limits stated separately from production claims.

Revisit if missed guards, replay-hint memory, mixed query capabilities or lost cross-actor grouping savings dominate the measured network benefit. Neki is not a supported backend and receives no claim from this decision.
