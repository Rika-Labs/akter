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

Measured values come from one 4-vCPU cloud VM with Postgres 18.6 on loopback TCP, not Neki, and from one runtime process ([results](#measured-results-2026-09-25)). They test whether this runtime reaches each number on that machine and say nothing about production capacity.

| Quantity                         | Hypothesis                                                        | Measured (one VM, local Postgres 18)                                                                                  | Status                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Durable turns per shard          | 5,000–20,000/second; plan with 10,000                             | At most about 460 turns/second in total; the runtime process saturates one core while Postgres uses under half of one | Untested: one runtime process cannot load the database; needs several runners                                 |
| Usable data per shard            | 15 TB, below the 32 TB PostgreSQL relation limit                  | Not measured                                                                                                          | Untested                                                                                                      |
| Stored actor overhead            | 175–250 bytes plus state                                          | Not measured                                                                                                          | Untested                                                                                                      |
| In-region warm write p50 on Neki | 3–6 ms with two round trips                                       | 2.9 ms p50 and 6.7 ms p99 on local Postgres, with 14 round trips                                                      | Neki untested. Latency is inside the range only because loopback is fast; the two-round-trip design is missed |
| Hot-actor throughput             | 150–400 commands/second unbatched; 2,000–10,000 with turn batches | 311/second with one caller; 374–401/second with 8 or 64 callers                                                       | Unbatched met, at the top of the range. Batched untested: turn batches are not implemented                    |
| Wake latency                     | 5–15 ms                                                           | First turn after hibernation: 3.7 ms p50, 13.7 ms p99. First turn of a never-seen actor: 3.6 ms p50, 7.7 ms p99       | Met on local Postgres                                                                                         |

Split a shard, or stop placing new keys on it, when any of these persists at normal peak: primary CPU above 60–70%; autovacuum not returning dead tuples to baseline between peaks; transaction-ID age approaching `autovacuum_freeze_max_age` faster than vacuum advances it; replica or relay lag rising; heap-only update ratio falling on framework tables.

## Required scale benchmarks

- **Flat latency with stored actors:** a fixed 10,000 turns/second on one shard with 10^5, 10^7, and 10^9 stored actors. Turn p99, wake latency, and timer lateness must stay within 10% across the three.
- **Linear scale-out:** 1, 2, 4, 8, and 16 Neki shards with turns/second per shard held constant, including during an online reshard. Measure the single `cluster_*` shard group separately.
- **Hot-actor ceiling:** maximum durable commands/second for one actor with turn batches off and on.
- **Round trips:** database round trips per turn, expected to be two.
- **72-hour soak:** vacuum progress, transaction-ID age, WAL bytes per turn, full-page-image ratio, replica lag, and relay lag.
- **Failure drills:** runner kill, shard primary failover, and relay crash, with recovery time and duplicate/lost-work checks.
- **Remote users:** p50/p99 for a tenant served from its home region versus from a remote single region.

## Measured results (2026-09-25)

`bun run bench` in `tooling/benchmarks/` produced these results ([how to run and compare](../../benchmarks/README.md)). The raw files are `benchmarks/results/2026-09-25-8da5f88-main-*.json` for `main` and `benchmarks/results/2026-09-25-5e25b07-m1-merge-*.json` for a local merge of the open M1 pull requests #34, #36, #33, and #32.

**Where and how.** Everything ran on one cloud VM with 4 vCPUs (AMD EPYC), 15.6 GiB of memory, and Linux 6.1. The benchmark client, the actor runtime (one Bun process, Effect `4.0.0-rc.116`), and Postgres 18.6 in Docker share those CPUs, and the database is reached over loopback TCP. Postgres ran with its default settings (`fsync`, `synchronous_commit`, and `full_page_writes` on; `shared_buffers` 128 MB), one fresh database per case, and a runtime pool of 10 connections unless a case says otherwise. There was no replica, no network hop, no Neki router, and no injected failure. Datasets were at most 100,000 actors with uniform key choice and no tenant skew. None of this generalizes to a hosted deployment, and the PGlite results do not generalize to lock contention or multi-process behavior.

**Noise.** Two runs of identical runtime code on this VM differed by up to about 45% on some `state-size` and `query-latency` cases, and tail percentiles moved more than medians. Treat single-run differences below that as noise.

### Postgres 18, `main`

| Case                                         | Throughput (op/s) | p50 (ms) | p95 (ms) | p99 (ms) | Statements/op |
| -------------------------------------------- | ----------------: | -------: | -------: | -------: | ------------: |
| Warm turn, one actor, one caller             |               311 |      2.9 |      5.2 |      6.7 |            11 |
| Hot actor, 8 callers                         |               374 |     20.7 |     26.9 |     32.7 |            11 |
| Hot actor, 64 callers                        |               401 |    157.0 |    180.6 |    191.4 |            11 |
| First turn of a new actor                    |               244 |      3.6 |      6.3 |      7.7 |            13 |
| First turn after hibernation                 |               196 |      3.7 |     12.5 |     13.7 |            13 |
| Query, one caller                            |             3,735 |     0.22 |     0.46 |     1.74 |             1 |
| Query, 64 callers over 1k actors             |             3,269 |      2.0 |      6.5 |      8.3 |             1 |
| Receipt replay (same command id), one caller |             1,509 |     0.56 |     0.84 |     2.61 |             4 |
| Receipt replay, 64 callers                   |             3,349 |      2.1 |      5.2 |      6.8 |             4 |
| 64 callers over 1k warm actors               |               460 |    101.0 |    390.9 |    599.6 |            11 |
| 64 callers over 10k warm actors              |               239 |    177.6 |    789.0 |  1,346.4 |            11 |
| 64 callers over 100k actors                  |               121 |    341.3 |  1,643.5 |  2,701.6 |          12.9 |
| 10k actors, pool of 50                       |               329 |    182.7 |    307.4 |    390.7 |            11 |

State size, one caller, sizes below the default 64 KiB `maxStateBytes`:

| State  | Rewrite blob every turn (p50 / p99 ms) | Hold blob, change counter (p50 / p99 ms) | Wake after hibernation (p50 / p99 ms) | zstd size | zstd compress / decompress p50 |
| ------ | -------------------------------------: | ---------------------------------------: | ------------------------------------: | --------: | -----------------------------: |
| 256 B  |                             3.9 / 14.0 |                                2.8 / 6.1 |                            5.2 / 11.6 |     262 B |               0.015 / 0.004 ms |
| 4 KiB  |                             3.3 / 12.0 |                                2.9 / 5.9 |                            5.6 / 12.1 |   3.1 KiB |               0.014 / 0.010 ms |
| 16 KiB |                             3.4 / 13.0 |                                2.6 / 5.8 |                             4.2 / 8.5 |  12.0 KiB |               0.056 / 0.056 ms |
| 32 KiB |                             8.0 / 24.4 |                                2.8 / 6.7 |                            6.0 / 17.3 |  24.0 KiB |               0.052 / 0.061 ms |
| 60 KiB |                             7.2 / 26.1 |                                2.9 / 7.9 |                            5.7 / 14.5 |  44.9 KiB |               0.085 / 0.104 ms |

The blob is random alphanumeric text, so zstd saves only about 25%. In the rewrite case the blob is also the command's input, so its cost includes a payload of up to 60 KiB that is sent to Postgres twice for hashing.

### PGlite 0.5.8, `main`

PGlite has one in-process connection. A warm turn takes 5.9 ms p50 and 19.2 ms p99 (134 op/s). A hot actor reaches 210 op/s with 64 callers. The first turn after hibernation takes 6.1 ms p50. A query takes 0.41 ms p50 and a receipt replay 1.2 ms p50. 64 callers over 1k or 10k actors reach 180–200 op/s at about 320–350 ms p50. PGlite is a test and embedded backend; these numbers only bound local development.

### With the open M1 pull requests

The local merge of #34 (outbox, intents, timers), #36 (effects), #33 (events), and #32 (reducers) issues the same statements per operation as `main` in every case (11.01 against 11 for a warm turn), so a turn that does not use the new features gains no round trip. Its warm turn is 3.0 ms p50 and 7.0 ms p99 (298 op/s); the hot actor under 64 callers reaches 379 op/s; the first turn after hibernation is 3.5 ms p50; 10k actors reach 253 op/s; and receipt replay is 0.61 ms p50. `bun run bench:compare` flags differences in `state-size` and `query-latency` that are inside the run-to-run noise above. None of the four slices has its own scenario yet, so outbox relay latency, timers due at scale, event append and replay, and effect round trips are untested.

### Bottlenecks

1. **Runtime CPU, not the database.** A warm turn takes 2.9 ms end to end, but Postgres spends 0.11 ms executing its statements (from `pg_stat_statements`). With one caller, the runtime process uses about 90% of a core at 311 turns/second, which is about 2.9 ms of CPU per turn; Postgres uses 22%. Under load, the process uses 150–185% while Postgres uses 19–45%. About half of the pooled connections sit `idle in transaction` waiting on the client (`Client/ClientRead`) during a turn. A CPU profile of the hot-actor case spends its time in Effect's fiber run loop, the Postgres driver's socket writes, and schema encoding, not in zstd or SQL. More connections or a larger database will not raise throughput until the runtime does less work per turn or runs on several processes.
2. **Round trips.** A warm turn issues 14 sequential statements, where ADR 0005 expects two pipelined round trips. Before the transaction come three `clock_timestamp()` reads for command-id checks, two `$1::jsonb::text` canonicalizations of the same payload, and one receipt lookup. Inside the transaction come `BEGIN`, `set_config`, a generation insert, the fenced admission read, a `SAVEPOINT` around the handler, the state upsert, the receipt insert, and `COMMIT`. A new activation adds a generation `UPDATE` and a state read (13 tracked statements plus transaction control). On loopback each round trip is cheap. Over a real network, and through a Neki router with cross-zone commit, it is the dominant cost.
3. **Connection pool under many callers.** With 64 callers over 10k actors, raising the pool from 10 to 50 connections cut p99 from 1,346 ms to 391 ms and raised throughput from 239 to 329 op/s. A pool of 25 changed little. Callers queue on the pool while pooled connections wait on the runtime, so the pool amplifies the CPU bottleneck rather than replacing it.
4. **The runner-wide activation cap.** Effect Cluster admits at most 10,000 resident entities per runner by default (`maxResidentEntities`), and the framework does not configure it. Touching 100,000 actors within the 60-second `hibernateAfter` window failed 8,225 commands (12,291 on the merge run) with `MailboxFull`, although the actor's policy leaves its mailbox unbounded and the handle's types do not list `MailboxFull` for an unbounded mailbox. This is a contract gap as well as a capacity limit.
5. **Memory per touched actor.** Resident memory after first touch grew from 283 MiB at 1k actors to 889 MiB at 10k and 2.6 GiB at 100k, about 26 KiB per actor touched. At 100k, the 10,000-entity cap was holding fewer activations than that, so part of this memory outlives activations. The cause is not identified yet.
6. **Not bottlenecks here.** The generation fence costs about 0.02 ms of server time per turn. A hot actor is limited by its one-turn-at-a-time serialization and the runtime CPU: 64 callers gain only 30% over one. zstd takes at most 0.1 ms at 60 KiB, and holding a 60 KiB state while changing a counter costs the same as a 256 B state. A hibernated actor wakes with a 60 KiB state at about the same latency as with a small one.

### Recommendations (not applied)

These are cheap and do not change semantics, but they are runtime changes and belong in their own pull requests:

- Compute the payload hash and the database time once per command instead of twice and three times. That removes three to four round trips from every command.
- Configure `maxResidentEntities` from actor policy or deployment options, and map runner-capacity rejections to a distinct `ActorError` reason, or make an unbounded mailbox mean that no capacity rejection is surfaced.
- Size the default pool to expected caller concurrency, or document that 10 connections cap concurrent turns.
- Find where resident memory per touched actor goes before any claim above 10k actors per runner.
- Add a measured stored-actor-overhead case (relation sizes after N actors) and several-runner cases before testing the per-shard turn hypothesis.
