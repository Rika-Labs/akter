# ADR 0011: Direct commands, one outbox, and the performance architecture

**Status:** accepted design (2026-09-23); implementation, conformance, and benchmarks remain pending.

**Responsibility:** record the owner's choices for command delivery, durable intents, turn pipelining, reducers, reads, storage, and operations, each with one mechanism.

**Authority:** historical decision record.

**Owner role:** runtime architecture.

**Change policy:** supersede through a new ADR when these semantics change.

## Context

Foundation F3 persists every command as a Cluster message before its turn runs. That costs three writes per command (message insert, receipt, message delete). On Neki it also routes every command through the single `cluster_*` shard group, which [ADR 0006](0006-scale-rules-placement-and-query-tiers.md) names as the expected first global bottleneck. Durable intents currently take two paths: `cluster_messages` on Postgres, and `actor_outbox` plus a relay on Neki.

The owner chose direct commands as the only command path, with no per-command alternatives, and accepted the related performance proposals from the competitive review against Rivet Actors and Cloudflare Durable Objects.

## Decisions

### Commands are direct; the receipt is the only durable admission record

A command call routes to the actor's current owner as a volatile Cluster message (`ClusterSchema.Persisted` false) and runs in the two-round-trip turn from [ADR 0005](0005-turn-latency-batching-and-regional-placement.md). The receipt, inserted under the generation fence and committed with the turn, is the durable record of the command.

- **Accepted means committed.** Before commit, a lost runner loses the command. The handle retries retryable failures with the same command id until the delivery timeout. A retry after commit replays the receipt without rerunning the handler.
- **Caller give-up.** A caller that stops waiting cannot tell whether the command committed; retrying with the same id answers that. The external retry horizon from [ADR 0007](0007-foundation-command-protocol.md) bounds how long an id stays valid.
- **Revocation.** Revocation blocks new commands. Committed commands and their durable intents, timers, workflows, and effects continue, as [ADR 0004](0004-receipt-access-revocation-and-expiry.md) requires for accepted work.
- **One path.** No persisted-command mode and no fire-and-forget call exist. Work that must survive a caller crash is an intent written by a turn, or a workflow.

### One outbox carries every durable intent and timer

Every durable intent lives in `actor_outbox` on the sending actor's shard and is written in the sending turn. That covers actor messages, self-messages, delayed and keyed timers, workflow starts and cancellations, and effect obligations. A relay loop on each runner scans the `(bucket, due_at)` buckets it owns and delivers each due intent as a direct command, using the intent id as the command id. It deletes the row after the receiver's receipt commits. The receiver's receipt deduplicates redelivery.

The same path serves the same shard, another Neki shard, and another region. The earlier `cluster_messages` intent write and the separate Neki relay into `cluster_messages` are removed. The `(bucket, due_at)` index fulfills ADR 0006's due-work scan.

The workflow engine keeps its own persisted storage; Effect's `ClusterWorkflowEngine` uses Cluster message storage. Its Neki placement is an open design question: it must not become a hot path for ordinary commands.

### Turn batches are pipelined

**Amended by [ADR 0020](0020-two-round-trip-turn-pipeline.md):** no handler runs speculatively. While batch N commits, batch N+1's `BEGIN` and admission statements may be sent in the same flight, behind N's `COMMIT`, on the same session; batch N+1's handlers run only after its own fence and receipt replies arrive, so there is no staged work of N+1 to hide while N commits. Replies, broadcasts, and outbox visibility still follow each commit. If batch N fails to commit, batch N+1's transaction is rolled back unseen, the activation restarts, and the callers of both batches retry. The batch cap, per-command failure isolation, and no-added-wait rules from ADR 0005 remain. The activation's mailbox is the framework's own, fed by Cluster, not `Entity.toLayerQueue`.

The original text, superseded: the activation consumes its mailbox through `Entity.toLayerQueue` and runs batch N+1's handlers in memory against batch N's staged state while batch N commits.

### Reducers run on the client and may merge commutatively

`Actor.reducer` ([ADR 0010](0010-one-way-effect-native-api.md)) supplies one pure `reduce(state, input)` used in two places.

- **Browser.** A browser handle applies the reducer optimistically, re-applies pending inputs over each committed state, and removes a pending input when its receipt arrives, rolling it back if the receipt is a failure.
- **Commutative merging.** A reducer declared `commutative: { combine }` may be merged: each runner combines inputs per actor for up to 10 ms, runs one turn with the combined input, and commits one receipt per original command id in that turn. Merging requires `reduce` to satisfy `reduce(reduce(s, a), b) = reduce(s, combine(a, b))`, which the conformance suite checks with generated inputs.

Bounded shared resources (escrow) are not part of this decision.

### Reads: every query is served from the nearest caught-up replica

A handle records the highest commit version it has observed and sends it with every query. The nearest replica, including edge caches fed by committed changes, answers once it has reached that version, so reads see the caller's own writes. Otherwise the query falls through to the home region. There is no per-query read setting.

Fleet queries ([ADR 0006](0006-scale-rules-placement-and-query-tiers.md)) exist only as declared `Fleet.view` definitions maintained incrementally from the change feed and read through `Fleet.subscribe`. The engine that maintains views is an open choice: candidates include Electric SQL, Materialize, RisingWave, Feldera, and `pg_ivm`.

### Durability has one level

Every command commits with PlanetScale's cross-availability-zone acknowledgment. No `local` or `memory` durability levels exist. Ephemeral data, such as cursors and typing indicators, travels as connection frames and never enters a turn.

### State is compressed, and idle state moves to a cold tier

- **Compression.** `actor_state.value` becomes `bytea`: the schema-encoded JSON value, compressed with zstd using a per-actor-type dictionary. State is opaque to SQL; anything worth querying belongs in an actor table.
- **Cold tier.** State and blobs of actors idle beyond a retention threshold (initial default 30 days) move to object storage, leaving `value` null and a `cold_ref` pointer. Wake rehydrates them in the admission round trip.

### Operations are automatic

- **Same-AZ placement.** Each Cluster shard group runs in the availability zone of its Neki shard primary, so the replica acknowledgment is the only cross-zone hop in a turn.
- **Prewarming.** Opening a connection or authenticating a session wakes the actors that session addresses. There is no prewarm API.
- **Tenant moves.** `durable tenants move <tenant> --to <shard>` moves one routing-key range online using Neki resharding. Detecting hot tenants and running moves is an operator action, not automatic.

### Evidence comes from deterministic simulation and published benchmarks

`ActorTest.simulate({ seed, faults }, program)` runs the real turn path under a seeded scheduler and injected faults: crash before and after commit, dropped replies, primary failover, relay crash, and clock skew. It asserts exactly-once receipts and outbox delivery, and every simulation failure reproduces from its seed. The benchmark scenarios in [performance](../verification/03-performance.md) are published with their harness and raw results.

### Deferred

Running customer actors in V8 isolates for hosted density is deferred until hosted margins require it.

## Alternatives

- **Queue every command (current F3):** rejected. Three writes per command and a global shard group on every request.
- **Direct by default plus an opt-in persisted mode:** rejected. Two ways to call with different failure behavior.
- **Per-command durability levels:** rejected. Speed that silently risks acknowledged writes is a footgun.
- **Keep `cluster_messages` for Postgres intents and the relay for Neki:** rejected. Two intent paths.
- **Per-query edge settings:** rejected. The version token gives read-your-writes without configuration.

## Consequences and evidence

This ADR supersedes:

- foundation F3's persisted command messages;
- foundation F5's `cluster_*` single-shard-group intent handoff;
- ADR 0002's Neki relay into `cluster_messages`;
- the Cluster-persistence parts of ADR 0007 and ADR 0008: persisted Cluster envelopes as accepted work, and redelivery from `cluster_messages`.

It also resolves the per-actor mailbox alternative left open in ADR 0006, and it satisfies the [receipt](../contracts/04-receipts.md) and [recovery](../contracts/09-recovery.md) contracts through receipts and the outbox.

The implemented M0 runtime persists commands in `cluster_messages`. Its conformance cases for redelivery from persisted envelopes, and for process-kill recovery of accepted but uncommitted commands, must be rewritten to cover caller retry and outbox recovery. Until that migration, the M0 evidence describes the current code, not this design.

New conformance and simulation checks are listed in conformance.

## Revisit when

- Benchmarks show caller-side retry after runner loss produces unacceptable tail latency.
- The workflow engine's storage cannot be placed off the command hot path.
- A reducer merge law cannot be checked reliably for a realistic reducer.
