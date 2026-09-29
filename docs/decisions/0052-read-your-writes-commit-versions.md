# ADR 0052: Read-your-writes commit versions and replica reads

**Status:** accepted (2026-09-30, issue #229). It fills in what [ADR 0027](0027-served-protocol.md) section 5 left to M4.9 ("M4.9 decides what it counts"), and records that the reserved migration `0019_commit_version` is not needed.

**Responsibility:** decide what a `durable-version` token counts, how a runner reads a replica, and when a query falls through to the primary.

**Authority:** design decision record.

**Owner role:** runtime/protocol.

**Change policy:** supersede through a new ADR.

## Context

[ADR 0011](0011-direct-commands-outbox-and-performance.md) says a handle sends the highest commit version it has seen with every query, and the nearest replica answers once it has reached that version; otherwise the query falls through. [ADR 0027](0027-served-protocol.md) section 5 fixed the wire form: a command response carries `durable-version`, a query may carry `durable-min-version`, a token is a non-negative decimal integer without leading zeros, and a client keeps the greatest it has seen per `baseUrl`. The Promise client has carried the token since M3.4, but no server issued one, and queries always read the primary. Invariant Q1 says queries observe the caller's own writes.

A token compared as one number across every actor the client wrote must be a position in one global order that a replica can check against. The replica must be able to prove it has everything at or below that position.

## Decision

- **A version is a WAL position.** A token is the primary's WAL insert LSN, `pg_current_wal_insert_lsn() - '0/0'`, in decimal. Physical streaming replicas replay WAL in order, and a commit is visible on a hot standby once its commit record is replayed. So a replica whose `pg_last_wal_replay_lsn()` is at least the token sees every commit the token covers.
- **Read after the transaction, on the same session.** A turn reads the version on its own session right after `COMMIT` (or `ROLLBACK`, for a replayed receipt), in the commit group's flight. The read adds a statement but no round trip. Postgres has already inserted the commit record when `COMMIT` answers, so the insert position read after it is at least the record's end. A version read inside the transaction would come before the commit record and prove nothing, so no version is stored with a receipt or with state. A receipt replayed at external admission, outside the turn, reads the position in the same statement as the receipt. That statement's snapshot already includes the receipt's commit, and the position is read after the snapshot is taken.
- **What carries it.** Every command, reducer, and workflow start that commits or replays answers `durable-version` over HTTP, declared failures included, since their receipts commit. A defect carries none. Queries carry none. In process, `execute` returns the version with the outcome over Cluster RPC. The runtime keeps the highest version any command sent through it has returned, and every in-process query sends it. That is ADR 0011's "handle" for the Effect API: one per runtime, not one per actor.
- **Replica configuration.** `Database.postgres({ ..., replica })` gives a runner one pool to its nearest streaming replica of the same primary (default 10 connections, opened only as queries need them). There is no per-query setting (ADR 0011).
- **The check comes first, in its own statement.** A query with `durable-min-version` first runs `pg_last_wal_replay_lsn() - '0/0' >= token` on the replica. Only when that holds does it read state and events there, in later statements whose snapshots come after the check. A check inside the reading statement could pass after that statement's snapshot was taken without the commit. A server not in recovery reports no replay position and never counts as caught up.
- **Fall through at once.** A replica that is behind, or whose check or read fails with a SQL error (unreachable, a recovery conflict), hands the whole query to the primary. The query never waits for replay: the primary always satisfies the token. The query's `commandTimeout` bounds the check, the replica read, and the primary read together. A query with no token reads the replica whenever one is configured.
- **Row-level security holds on the replica.** With `rowLevelSecurity` on ([ADR 0051](0051-row-level-security.md)), a query's reads run in a transaction bound to its tenant (role and `durable.tenant`) on whichever server answers, so a replica read is confined exactly as a primary read is. A replica where the role is refused fails the read, which falls through to the primary.
- **One server per query.** An actor type that declares owned tables or blobs reads them through the primary's pools, so its queries read state on the primary too.
- **Malformed tokens are refused.** A `durable-min-version` that is not a well-formed token answers `400 InvalidInput { code: "decode" }` with the issue path `durable-min-version`. Ignoring it would silently drop the caller's guarantee. A well-formed but forged high token only sends the query to the primary, as ADR 0027 says.
- **No migration.** Nothing is stored, so `0019_commit_version` stays an unused number. The migrator allows gaps, and renumbering the later M4 migrations for it is not worth the churn.

## Alternatives

- **A per-actor version column (what `0019_commit_version` anticipated).** A replica could check the actor's own row, which also works per shard. But ADR 0027's client keeps one token per `baseUrl`, the greatest across every actor. A per-actor version compared against another actor's higher token would send almost every query to the primary. Per-actor tokens would change the client and ADR 0027. This can be revisited when Neki shards need it.
- **A global sequence or clock value written inside the turn.** Neither is ordered like WAL commit order, so a replica can't prove it has replayed every commit at or below one.
- **Waiting a bounded time for the replica.** This adds a setting, and adds latency to the case where the primary answers at once. Rejected until measurements ask for it.
- **The replica check inside the reading statement.** Unsound, for the snapshot reason above.

## Limits

- Tokens order commits within one Postgres primary and its physical replicas. On Neki, each shard has its own WAL, so one scalar per `baseUrl` cannot order commits across shards. That needs its own decision before Neki replica reads.
- Edge caches fed by committed changes (ADR 0011) are not built. One would track the LSN it has applied and use the same check.
- After a failover, a token from the old primary that was never replicated stays above the new primary's replay position until the new timeline passes it. Until then, such queries read the primary.

## Consequences and evidence

- [Protocol contract](../contracts/protocol.md), [server API](../api/01-server-api.md), and [TypeScript SDK](../api/03-typescript-sdk.md): `durable-version` is issued and `durable-min-version` is honored.
- `conformance/read-your-writes.ts` runs on real Postgres against a real streaming replica (`TEST_REPLICA_DATABASE_URL`). With replay paused (`pg_wal_replay_pause()`), it shows that a query carrying the caller's version is answered by the lagging replica when that replica has the write, and by the primary when it doesn't. A tokenless query reads the stale replica. An unreachable replica falls through to the primary. The Promise client sends the greatest version it was issued and reads its own writes. An in-process handle does the same. The version is present, well formed, and increasing on commit, and no lower on replay; malformed tokens are refused.
- The Statements gate counts one more statement per turn, the post-commit version read.
