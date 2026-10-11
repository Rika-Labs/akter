# ADR 0119: Explicit transaction pooling for socket runners

**Status:** accepted (2026-10-10), narrow implementation of [ADR 0117](0117-pooler-safe-locking.md).

## Decision

Add `Database.postgres({ pooling: "transaction" })`. Do not infer a pooler's behavior from a hostname, URL or connection count. The mode supports public `Runner.socket` table leases on one primary database. It rejects embedded/advisory runners, fleet, cold storage, replicas and separate coordination before runtime migrations or registration. Existing direct configuration and the four-logical-client low-connection preset keep their defaults and bounds.

The pooled driver always uses `prepare: false`, including when a caller supplies `prepare: true`. It omits injected server keepalive startup GUCs; operators configure proxy/client and proxy/server transports separately. Transaction-local tenant/role settings remain transaction-local. Application `LISTEN`, session locks, temporary tables and arbitrary session state are not supported through this endpoint.

Disable `WarmTurnFastPath` through its existing context. The speculative path reads the session's `durable.turn_xid` after COMMIT; a transaction pooler may already have reassigned that backend. Ordinary fenced admission is the supported path. This decision does not modify the warm-path implementation or its direct-endpoint behavior.

## Startup and ownership

`withMigrationCoordination` now uses the bounded source client's `withTransaction`, taking `pg_advisory_xact_lock` before any DDL. It creates the requested history table with the pinned Effect migrator's schema before calling that migrator: Effect 4.0.2 first probes `::regclass` and catches a missing-table error outside its own transaction. Inside our outer transaction that error would abort everything. Pre-creation under the startup lock avoids both the abort and concurrent catalog creation races. Both actor and coordination ledgers use this path; applied migrations are unchanged. Rollback also removes a newly created ledger.

Cluster's table-mode lifetime reservation remains. It consumes one of the two off-turn logical clients but does not hold a server backend between transactions. Eliminating it is not required for transaction pooling and would require changing upstream ownership boundaries. Budget logical clients and physical backends independently. The low-connection preset remains 1/2/1, not 1/1/1, and a global backend budget must also permit progress when one transaction waits on another.

The bounded adapter now keeps a reservation checked out until its outstanding statement cleanup finishes. Cluster replaces a timed-out lock connection while the old operation may still be draining cancellation. Returning that pinned connection early permits another borrower to replace its wire consumer, stranding the old cleanup and later process shutdown. A reservation-local statement gate closes before the underlying pin/pool lease is released; queued statements cannot begin after close. It changes neither checkout counts nor wait bounds and leaves the turn pipeline untouched. The real proxy blackhole/restart case rejects the old implementation by also requiring clean process exit within five seconds after drain.

Fleet and cold-storage session locks remain on direct endpoints. We do not move long object/slot I/O into startup or ownership transactions. Table lease expiry triggers reacquisition, but durable generation/row locks remain the write authority; loss or reassignment of a logical client grants no stale write permission.

## Evidence and limits

The Docker fixture pins `edoburu/pgbouncer:v1.25.1-p0` by digest. That image reports binary **1.25.2**; its tag is not evidence for binary 1.25.1. It runs transaction mode with prepared statements disabled and server reset after every transaction, against a Postgres 18.6 server. Tests force and observe backend PID reassignment, separately count client sockets and backend sessions, and use fewer backends than clients. Startup, transaction protocol, public serving and ownership-recovery cases are linked in [verification](../verification/low-connection-postgres.md#transaction-pooling).

This is Bun loopback evidence, not certification of other proxies, proxy versions, managed providers, Node pooled transport, cross-host networking, session pooling or statement pooling. Pooler TLS, provider failover, fleet/cold tier and separate authority remain gated. Direct low-connection evidence is retained independently; it is not routed through the proxy or treated as proxy evidence.
