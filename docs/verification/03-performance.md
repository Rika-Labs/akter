# Performance and capacity

**Responsibility:** replace scaling assumptions with measurements.  
**Authority:** evidence.  
**Owner role:** performance/reliability.
**Change policy:** a change requires the conformance suite to be updated in the same change.

Benchmarks MUST measure command p50/p95/p99, hot-actor throughput, transaction duration, database round trips and pool waits, receipt/event/outbox growth, mailbox age, hibernation and wake latency, parked-connection memory, event replay lag, workflow resume latency, Neki relay lag, and recovery after runner death.

Capacity tests MUST include `State.maxBytes`, the 16 KiB connection-state limit, cluster principal-header size, mailbox capacity, event retention, and reconnect waves. Singleton tests MUST show one active `run` and one cron tick across runner counts.

Every result MUST record runtime and backend versions, deployment mode, topology, database settings, indexes, dataset size, tenant/key skew, hardware, concurrency, durability settings, and injected failures. PGlite results MUST NOT be generalized to lock contention or multi-process Postgres/Neki behavior.

No estimate becomes a product claim without a reproducible command, fixture, raw result, and acceptance threshold.

## Planning envelope (hypotheses)

[ADR 0005](../decisions/0005-turn-latency-batching-and-regional-placement.md) and [ADR 0006](../decisions/0006-scale-rules-placement-and-query-tiers.md) size shards and set competitive targets from published benchmarks, not measurements of this runtime. Each number below is a hypothesis for the benchmarks that follow.

| Quantity                         | Hypothesis                                                        |
| -------------------------------- | ----------------------------------------------------------------- |
| Durable turns per shard          | 5,000–20,000/second; plan with 10,000                             |
| Usable data per shard            | 15 TB, below the 32 TB PostgreSQL relation limit                  |
| Stored actor overhead            | 175–250 bytes plus state                                          |
| In-region warm write p50 on Neki | 3–6 ms with two round trips                                       |
| Hot-actor throughput             | 150–400 commands/second unbatched; 2,000–10,000 with turn batches |
| Wake latency                     | 5–15 ms                                                           |

Split a shard, or stop placing new keys on it, when any of these persists at normal peak: primary CPU above 60–70%; autovacuum not returning dead tuples to baseline between peaks; transaction-ID age approaching `autovacuum_freeze_max_age` faster than vacuum advances it; replica or relay lag rising; heap-only update ratio falling on framework tables.

## Required scale benchmarks

- **Flat latency with stored actors:** a fixed 10,000 turns/second on one shard with 10^5, 10^7, and 10^9 stored actors. Turn p99, wake latency, and timer lateness must stay within 10% across the three.
- **Linear scale-out:** 1, 2, 4, 8, and 16 Neki shards with turns/second per shard held constant, including during an online reshard. Measure the single `cluster_*` shard group separately.
- **Hot-actor ceiling:** maximum durable commands/second for one actor with turn batches off and on.
- **Round trips:** database round trips per turn, expected to be two.
- **72-hour soak:** vacuum progress, transaction-ID age, WAL bytes per turn, full-page-image ratio, replica lag, and relay lag.
- **Failure drills:** runner kill, shard primary failover, and relay crash, with recovery time and duplicate/lost-work checks.
- **Remote users:** p50/p99 for a tenant served from its home region versus from a remote single region.
