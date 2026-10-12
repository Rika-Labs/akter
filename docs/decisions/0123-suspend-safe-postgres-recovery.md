# ADR 0123: Suspend-safe Postgres socket epochs

Status: accepted, 2026-10-12.

## Context

A suspended runner can retain sessions whose peers have disappeared, including Cluster's lifetime lock reservation. Checkout validation does not reach that reservation. Waiting for the ordinary lock-refresh deadline and interrupted-query drain delays recovery even after the guest clock has corrected. Invalidating a pool alone does not immediately finalize a connection still leased by a turn or reservation.

## Decision

Each `Database.postgres` layer owns one socket epoch through the driver's public `stream` factory. Turn, off-turn, query, replica and coordination pools share it; Cluster's lock reservation uses the same bounded coordination client. Supplied factories are composed, and the driver still performs TLS negotiation and certificate verification. No private driver state, dependency patch, shorter global timeout or faster heartbeat is required.

The served clock and runtime use the same wall/monotonic divergence comparison. A clock-only one-second background tick also checks idle runtimes. A backward monotonic clock or elapsed-time disagreement greater than 250 milliseconds increments the epoch and withdraws readiness synchronously, before destroying every pre-epoch socket. Warm checks perform no SQL. Checkouts wait for every old public close notification and an event-loop turn so the driver's pool cannot hand a replacement reservation a dying session. A later discontinuity supersedes both the close barrier and recovery worker.

After teardown, readiness stays withdrawn until runner storage has refreshed its registration and Cluster has actually acquired all shards in the current healthy-runner assignment snapshot through its ordinary acquisition path. Recovery observes those successful new-epoch acquisitions; it never acquires or refreshes shard locks out of band, which could leave advisory locks held without Cluster bookkeeping. Pre-epoch refresh requests return no unproven shards, so Cluster drops its stale belief and handles release and reacquisition itself. A database probe or local `hasShardId` belief is insufficient, including for embedded Postgres readiness. The existing concurrent-acquisition cache is discarded across epochs and cannot report an old-epoch operation as freshly held. Public command admission and actor turn admission return retryable `ActorUnavailable` while this ownership recovery is incomplete. Generations, leases, command identities and receipt rules remain unchanged. Reopening still depends on Cluster's configured refresh and acquisition cadence; the one-second detector does not promise one-second ownership recovery.

## Limits and evidence

The detector starts working after a local clock reveals discontinuity. If a provider initially resumes both clocks together without correction, it cannot detect that residual interval; the limitation in [served-clock evidence](../verification/served-clock.md) remains. Recovery is not a provider wake-time guarantee or proof of the original packet-loss cause.

[Postgres recovery evidence](../verification/postgres-resume.md) covers real two-runner expiry and takeover, rollback of a staged old turn, readiness mutants, real reserved advisory locks, all five pools, supplied/default factories, verified TLS and independent warm statement counts on Bun and Node. PGlite has no network socket epoch.
