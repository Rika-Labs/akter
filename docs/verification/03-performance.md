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

| Quantity                         | Hypothesis                                                        | Measured (one VM, local Postgres 18)                                                                                          | Status                                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable turns per shard          | 5,000–20,000/second; plan with 10,000                             | At most about 450 turns/second in total. The benchmark process saturates about one core while Postgres uses under half of one | Untested: one runtime process cannot load the database, so several runners are needed                                                          |
| Usable data per shard            | 15 TB, below the 32 TB PostgreSQL relation limit                  | Not measured                                                                                                                  | Untested                                                                                                                                       |
| Stored actor overhead            | 175–250 bytes plus state                                          | Not measured                                                                                                                  | Untested                                                                                                                                       |
| In-region warm write p50 on Neki | 3–6 ms with two round trips                                       | 3.1 ms p50 and 6.7 ms p99 on local Postgres, with 14 round trips                                                              | Neki untested. Two round trips missed: the turn issues 14. Latency is near the bottom of the range only because loopback round trips are cheap |
| Hot-actor throughput             | 150–400 commands/second unbatched; 2,000–10,000 with turn batches | 290/second with one caller; 351–375/second with 8 or 64 callers                                                               | Unbatched met, near the top of the range. Batched untested: turn batches are not implemented                                                   |
| Wake latency                     | 5–15 ms                                                           | First turn after hibernation: 3.7 ms p50, 9.0 ms p99. First turn of a never-seen actor: 4.0 ms p50, 9.4 ms p99                | Met on local Postgres; p50 is below the range                                                                                                  |

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

`bun run bench` in `tooling/benchmarks/` produced these results ([how to run and compare](../../benchmarks/README.md)). The raw files are in `benchmarks/results/`:

- `2026-09-25-6022f56-main-*.json`: `main`.
- `2026-09-25-6022f56-main-repeat-postgres.json`: an identical repeat on Postgres, run to measure noise.
- `2026-09-25-a169bc7-m1-merge-*.json`: a local merge of the open M1 pull requests #34, #36, #33, and #32.

All ran from clean trees.

**Where and how.** Everything ran on one cloud VM with 4 vCPUs (AMD EPYC), 15.6 GiB of memory, and Linux 6.1. One Bun process ran both the benchmark client and the actor runtime, on Effect `4.0.0-rc.116`. It shared the VM's CPUs with Postgres 18.6 in Docker, reached over loopback TCP.

Postgres ran with default settings: `fsync`, `synchronous_commit`, and `full_page_writes` on, and `shared_buffers` at 128 MB. Each case got a fresh database, and the runtime pool had 10 connections unless a case says otherwise. There was no replica, no network hop, no Neki router, and no injected failure. Datasets were at most 100,000 actors, with uniform key choice and no tenant skew.

None of this generalizes to a hosted deployment. The PGlite results also don't generalize to lock contention or multi-process behavior.

**Noise.** Compare the `main` and `main-repeat` files to see run-to-run noise. Most cases differ by under 10% at p50 and throughput. The `state-size` cases run only 500 turns, or 100 wakes, per size, and they moved by up to 63% at p50 (`wake-16384`: 4.1 ms against 11.0 ms). Tail percentiles move more than medians. One earlier `main` run hit a machine-wide slowdown partway through: PGlite warm turns took 30 ms instead of 6 ms. That run was discarded and rerun, and no result here comes from it.

### Postgres 18, `main`

| Case                                         | Throughput (op/s) | p50 (ms) | p95 (ms) | p99 (ms) | Statements/op |
| -------------------------------------------- | ----------------: | -------: | -------: | -------: | ------------: |
| Warm turn, one actor, one caller             |               290 |      3.1 |      5.6 |      6.7 |            11 |
| Hot actor, 8 callers                         |               351 |     22.3 |     28.5 |     33.8 |            11 |
| Hot actor, 64 callers                        |               375 |    167.4 |    214.0 |    236.7 |            11 |
| First turn of a new actor                    |               218 |      4.0 |      7.6 |      9.4 |            13 |
| First turn after hibernation                 |               237 |      3.7 |      7.1 |      9.0 |            13 |
| Query, one caller                            |             3,626 |     0.23 |     0.43 |     1.84 |             1 |
| Query, 64 callers over 1k actors             |             2,842 |      2.3 |      7.8 |     10.1 |             1 |
| Receipt replay (same command id), one caller |             1,263 |     0.65 |     2.36 |     3.13 |             4 |
| Receipt replay, 64 callers                   |             2,857 |      2.6 |      5.9 |      7.5 |             4 |
| 64 callers over 1k warm actors               |               422 |    109.7 |    419.0 |    652.9 |            11 |
| 64 callers over 10k warm actors              |               241 |    179.5 |    767.0 |  1,374.3 |            11 |
| 64 callers over 100k actors, 92% cold turns  |               135 |    333.5 |  1,377.2 |  2,131.5 |          12.8 |
| 10k warm actors, pool of 25                  |               240 |    200.7 |    660.4 |  1,136.2 |            11 |
| 10k warm actors, pool of 50                  |               325 |    183.4 |    315.8 |    376.3 |            11 |

In the 100k case, actors are warm only while resident. The steady-state `coldFraction` shows that 92% of its turns started a new activation (see bottleneck 4). Statement counts come from `pg_stat_statements`. They exclude Cluster's runner bookkeeping and the transaction-control statements `BEGIN`, `SAVEPOINT`, and `COMMIT`, which it records once per distinct text rather than per call.

State size, one caller, at sizes below the default 64 KiB `maxStateBytes`:

| State  | Rewrite blob every turn (p50 / p99 ms) | Hold blob, change counter (p50 / p99 ms) | Wake after hibernation (p50 / p99 ms) | zstd size | zstd compress / decompress p50 |
| ------ | -------------------------------------: | ---------------------------------------: | ------------------------------------: | --------: | -----------------------------: |
| 256 B  |                              3.3 / 8.0 |                                3.6 / 9.9 |                             4.7 / 9.7 |     262 B |               0.008 / 0.002 ms |
| 4 KiB  |                              3.1 / 7.1 |                                2.8 / 6.0 |                             3.5 / 8.2 |   3.1 KiB |               0.024 / 0.017 ms |
| 16 KiB |                             4.1 / 14.6 |                                2.7 / 6.6 |                            4.1 / 11.9 |  12.0 KiB |               0.045 / 0.043 ms |
| 32 KiB |                             4.3 / 15.3 |                                2.9 / 6.5 |                            4.7 / 10.2 |  24.0 KiB |               0.052 / 0.061 ms |
| 60 KiB |                             6.0 / 19.8 |                                3.2 / 7.5 |                            4.5 / 14.6 |  44.9 KiB |               0.087 / 0.112 ms |

The blob is random alphanumeric text, so zstd saves only about 25%. In the rewrite case the blob is also the command's input, so its cost includes a payload of up to 60 KiB that is sent to Postgres twice for hashing.

### PGlite 0.5.8, `main`

PGlite has one in-process connection.

- **Warm turn:** 6.7 ms p50 and 18.9 ms p99, at 125 op/s.
- **Hot actor with 64 callers:** 212 op/s.
- **First turn after hibernation:** 6.5 ms p50.
- **Query:** 0.43 ms p50.
- **Receipt replay:** 1.3 ms p50.
- **64 callers over 1k or 10k actors:** about 180 op/s at 340–360 ms p50.

PGlite is a test and embedded backend, so these numbers only bound local development.

### With the open M1 pull requests

The local merge of #34 (outbox, intents, timers), #36 (effects), #33 (events), and #32 (reducers) issues the same statements per operation as `main` in every case: 11.01 against 11 for a warm turn. A turn that doesn't use the new features gains no round trip.

Merge results:

- **Warm turn:** 2.9 ms p50 and 6.7 ms p99, at 302 op/s.
- **Hot actor with 64 callers:** 370 op/s.
- **First turn after hibernation:** 3.4 ms p50.
- **Receipt replay:** 0.56 ms p50.
- **10k warm actors:** 189 op/s. This is within noise: the earlier merge run reached 253 op/s.

One difference exceeds the noise and repeated in both merge runs: rewriting a 16–32 KiB blob every turn. At 32 KiB, p50 was 12.4 and 11.8 ms on the merge, against 4.3 to 8.0 ms across four `main` runs. Statement counts are unchanged, so any extra cost is in the runtime, not the database. Treat it as a lead to confirm with a focused repeat, not an attributed regression.

None of the four slices has its own scenario yet. Outbox relay latency, timers due at scale, event append and replay, and effect round trips are untested.

### Bottlenecks

1. **The runtime process, not the database.** A warm turn takes 3.1 ms end to end, but Postgres spends 0.13 ms executing its statements, per `pg_stat_statements`, not counting `COMMIT` and its WAL flush.
   - **One caller:** the benchmark process, which holds the client, the actor runtime, and the driver, uses about 92% of a core at 290 turns/second. That is about 3.2 ms of CPU per turn, and Postgres uses 22%.
   - **Under load:** the process uses 135–185% while Postgres uses 20–45%. About half of the pooled connections sit `idle in transaction` waiting on the client (`Client/ClientRead`) during a turn.
   - **Profile:** a CPU profile of the hot-actor case, not committed, spends its time in Effect's fiber run loop, the Postgres driver's socket writes, and schema encoding. It spends almost none in zstd or SQL.
   - **Consequence:** more connections or a larger database won't raise throughput until the runtime does less work per turn or runs in several processes.
2. **Round trips.** A warm turn issues 11 statements that `pg_stat_statements` counts per call, plus `BEGIN`, a `SAVEPOINT` around the handler, and `COMMIT`: 14 sequential round trips, where ADR 0005 expects two pipelined ones.
   - **Before the transaction:** three `clock_timestamp()` reads for command-id checks, two `$1::jsonb::text` canonicalizations of the same payload, and one receipt lookup.
   - **Inside the transaction:** `set_config`, a generation insert, the fenced admission read, the state upsert, and the receipt insert.
   - **New activation:** adds a generation `UPDATE` and a state read.
   - On loopback each round trip is cheap. Over a real network, or through a Neki router with cross-zone commit, round trips become the dominant cost. Tracked in #40.
3. **Connection pool under many callers.** With 64 callers over 10k actors:

   | Pool | Throughput (op/s) | p99 (ms) |
   | ---: | ----------------: | -------: |
   |   10 |               241 |    1,374 |
   |   25 |               240 |    1,136 |
   |   50 |               325 |      376 |

   Callers queue for a connection while pooled connections wait on the runtime, so the pool amplifies bottleneck 1 rather than replacing it.

4. **The runner-wide activation cap.** Effect Cluster admits at most 10,000 resident entities per runner by default (`maxResidentEntities`), and the framework doesn't configure it.
   - **Failures:** touching 100,000 actors within the 60-second `hibernateAfter` window failed 8,241 commands with `MailboxFull`. The repeat run failed 10,085 and the merge 11,680.
   - **Contract gap:** the actor's policy leaves its mailbox unbounded, and the handle's types don't list `MailboxFull` for an unbounded mailbox. Tracked in #39.
   - **Effect on later turns:** because of the cap, 92% of steady-state turns over 100k actors started a new activation.
5. **Memory per activation.** Measured after a forced garbage collection, the heap grew by 150–490 MiB across the three clean runs when 10k actors were first touched, all of them resident. That is roughly 15–50 KiB per activation. At 100k actors the heap grew by 0.8–1.0 GiB, although the 10,000-entity cap held fewer activations than at 10k. So memory grew with commands executed, not only with actors resident, and part of it outlived hibernation.
   - **Cause (#41):** the runtime built a new Cluster entity object for every command, and Sharding caches one RPC client per entity object, by identity, until the runtime closes. Every executed command retained one client, about 11 KiB and 95 objects of JavaScript heap. The runtime now reuses one entity per actor type.
   - **Measured** by the `retained-heap` scenario on Postgres after every activation hibernated: 10.94 KiB and 95 objects retained per touched actor before the fix, at both 10k and 100k actors, and 0.09–0.11 KiB and 1 object after it. Sending 10,000 commands to one actor retained the same amount per command, so the growth was per command, including steady-state load.
   - **Remaining, in Effect Cluster:** with `MessageStorage.layerNoop`, Cluster's entity manager records every processed request id in a set that only its storage-read loop clears, and that loop doesn't run without storage. That keeps about 94 bytes per command for the runner's lifetime, roughly 1 GiB per 10 million commands. There's no safe workaround from the framework; it needs an upstream fix (#46).
   - **Not re-measured:** the fix accounts for about 11 KiB of the 15–50 KiB per resident activation seen during `many-actors` first touch. The rest is heap held while activations are resident, and `many-actors` hasn't been rerun since the fix.
6. **Not bottlenecks here.**
   - **Generation fence:** its statements cost about 0.02 ms of server time per turn.
   - **Hot actor:** limited by its one-turn-at-a-time serialization and by runtime CPU. 64 callers gain about 30% over one.
   - **zstd:** at most 0.11 ms at 60 KiB.
   - **Large stored state:** holding a 60 KiB state while changing a counter costs about the same as holding a 256 B state. A hibernated actor wakes with a 60 KiB state in about the same time as with a small one.

### Recommendations (not applied)

These are runtime changes, so each belongs in its own pull request:

- Compute the payload hash and the database time once per command, instead of twice and three times. That removes three to four round trips from every command (#40).
- Configure `maxResidentEntities` from actor policy or deployment options. Then either map runner-capacity rejections to a distinct `ActorError` reason, or make an unbounded mailbox mean that no capacity rejection is surfaced (#39).
- Size the default pool to the expected caller concurrency, or document that 10 connections cap concurrent turns.
- Report Cluster's never-cleared processed-request set under `MessageStorage.layerNoop` upstream (#46).
- Rerun `many-actors` after #41 and measure heap per resident activation before making any claim above 10k actors per runner.
- Add a measured stored-actor overhead case, using relation sizes after N actors, and several-runner cases before testing the per-shard turn hypothesis.
