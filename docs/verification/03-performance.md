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
- **Round trips:** database round trips per turn, expected to be two. The `Statements` CI job holds every pull request to `main` to the statements per operation in `benchmarks/baselines/statements.json`; a pull request that changes a count updates that file and says why ([benchmarks/README.md](../../benchmarks/README.md#statement-gate)).
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

The merge had no scenario for the four slices. Each has one now; `benchmarks/README.md` maps every shipped feature to its scenarios.

### Bottlenecks

1. **The runtime process, not the database.** A warm turn takes 3.1 ms end to end, but Postgres spends 0.13 ms executing its statements, per `pg_stat_statements`, not counting `COMMIT` and its WAL flush.
   - **One caller:** the benchmark process, which holds the client, the actor runtime, and the driver, uses about 92% of a core at 290 turns/second. That is about 3.2 ms of CPU per turn, and Postgres uses 22%.
   - **Under load:** the process uses 135–185% while Postgres uses 20–45%. About half of the pooled connections sit `idle in transaction` waiting on the client (`Client/ClientRead`) during a turn.
   - **Profile:** a CPU profile of the hot-actor case spends its time in Effect's fiber run loop, the Postgres driver's socket writes, and schema encoding. It spends almost none in zstd or SQL. The committed profiles are under [`benchmarks/profiles/`](../../benchmarks/profiles/); see [Runtime CPU per turn](#runtime-cpu-per-turn-60).
   - **Consequence:** more connections or a larger database won't raise throughput until the runtime does less work per turn or runs in several processes.
2. **Round trips.** A warm turn issues 11 statements that `pg_stat_statements` counts per call, plus `BEGIN`, a `SAVEPOINT` around the handler, and `COMMIT`: 14 sequential round trips, where ADR 0005 expects two pipelined ones.
   - **Before the transaction:** three `clock_timestamp()` reads for command-id checks, two `$1::jsonb::text` canonicalizations of the same payload, and one receipt lookup.
   - **Inside the transaction:** `set_config`, a generation insert, the fenced admission read, the state upsert, and the receipt insert.
   - **New activation:** adds a generation `UPDATE` and a state read.
   - On loopback each round trip is cheap. Over a real network, or through a Neki router with cross-zone commit, round trips become the dominant cost. Tracked in #40.
   - **After #40:** one statement before delivery reads the clock, the canonical payload, and any retained receipt; `set_config` runs inside the generation insert; the fenced admission read returns the canonical payload. A warm turn now issues 7 counted statements, 10 round trips, and a receipt replay 2 statements instead of 4. The remaining pre-transaction statements are the handle minting the command id and the clock recheck before a reply, which the receipt contract requires. `2026-09-25-f083e80-before-40-*.json` and `2026-09-25-6418ab9-after-40-*.json` hold the comparison: warm-turn p50 fell from 1.86 to 1.58 ms on Postgres on that run's machine.
3. **Connection pool under many callers.** With 64 callers over 10k actors:

   | Pool | Throughput (op/s) | p99 (ms) |
   | ---: | ----------------: | -------: |
   |   10 |               241 |    1,374 |
   |   25 |               240 |    1,136 |
   |   50 |               325 |      376 |

   Callers queue for a connection while pooled connections wait on the runtime, so the pool amplifies bottleneck 1 rather than replacing it.

4. **The runner-wide activation cap.** Effect Cluster admits at most 10,000 resident entities per runner by default (`maxResidentEntities`), and the framework didn't configure it before ADR 0019.
   - **Failures:** touching 100,000 actors within the 60-second `hibernateAfter` window failed 8,241 commands with `MailboxFull`. The repeat run failed 10,085 and the merge 11,680.
   - **Contract gap:** the actor's policy leaves its mailbox unbounded, and the handle's types don't list `MailboxFull` for an unbounded mailbox. Tracked in #39, and resolved by [ADR 0019](../decisions/0019-runner-capacity-and-pool-size.md). See "Runner capacity and pool size" below.
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

### Runtime CPU per turn (#60)

The runtime rebuilt schema codecs on every turn: every `Schema.decodeEffect(Schema.fromJsonString(...))` built inside a handler, a state write, a receipt, or a handle call compiled a new parser. It now builds each actor type's member, state, event, and effect codecs once, and the receipt, command-id, and entity-id codecs once per process. A turn also provides its context in one merge instead of four nested provides, each of which copied the fiber's context, and the turn span no longer captures a stack trace, which always pointed at the runtime's own file. No statement, receipt, span name, or span attribute changed; the one visible difference is that a pretty-printed defect cause shows the turn span's frame without the `register.ts` file and line.

Two sessions on one 4-vCPU VM measure it, each alternating the baseline with the change so both sides see the same machine load. The baseline, `a28605e`, is `main` plus the CPU-per-operation column and the profiler, with runtime code identical to `main`.

- **Final code:** `p3-before-hot-{1,2,3}` and `p3-final-hot-{1,2,3}` ran `hot-actor` on Postgres 18.6 as before, final, before, final, before, final. `5093945` holds the final runtime code except that it measured state size with `Buffer.byteLength`; the branch now uses a shared `TextEncoder`, as `main` did, so the browser-safe `actor/` module stays free of Node globals. Later commits otherwise add only results and docs.
- **First cut:** `p3-before`, `p3-after`, and their `-repeat` files ran `hot-actor` and `state-size` on Postgres as before, after, before, after, then once each on PGlite. `781ff5c` differs from the final code only in splitting encoded state with plain `JSON.parse` instead of the schema decoder, which lint rejects. The files name commits from before this branch was rebased onto `main` `1046deb`, which changed only docs and results.

Client CPU milliseconds per operation in the final-code session, mean of three runs each:

| Case                      | Before | After | Change |
| ------------------------- | -----: | ----: | -----: |
| `hot-actor/sequential`    |   2.58 |  2.39 |    −7% |
| `hot-actor/concurrent-8`  |   2.60 |  2.27 |   −13% |
| `hot-actor/concurrent-64` |   2.54 |  2.16 |   −15% |

Every final run was below every baseline run in all three cases. Throughput rose 6% for one caller (369 to 391 op/s), 10% for 8 callers, and 9% for 64. The first-cut session agrees: −10%, −12%, and −12% on the means of two runs each. Statements per operation stayed at 7.01 for `hot-actor`, and every `state-size` case stayed within 0.02 of its baseline (`rewrite-*` 8.00–8.03, `hold-*` 7.00–7.01, `wake-*` 9.00–9.05). On PGlite, one pair of runs showed CPU per turn 3–14% lower across the three `hot-actor` cases. In the profiles (`benchmarks/profiles/*-p3-{before,after}-postgres-hot-actor.md`), self time in Effect's schema modules fell from 1,670 to 1,071 ms over 5,000 turns, and CPU per turn under the profiler fell from 3.77 to 3.45 ms.

Most of what remains isn't in the runtime's own code: about 40% is Effect's fiber run loop and context handling, and about 35% is native, largely the socket write each statement makes (`writeBuffered`, 18–19%). A bare `SELECT 1` costs about 70 µs of client CPU through `@effect/sql-pg` on this machine, so the 10 round trips of a warm turn cost close to 1 ms before any actor work. Fewer round trips (P4) cut that directly; the runtime cannot without changing statements.

**The 16–32 KiB rewrite lead did not reproduce.** On `main` as of this branch, `rewrite-32768` on Postgres took 4.7 and 3.5 ms p50 in the two first-cut baseline runs, against 12.4 ms in the committed M1-merge Postgres run that raised the lead. The change's two runs took 8.8 and 3.7 ms. With two runs a side, one slow run in four whose repeat on the same code was fast reads as run-to-run noise in a 500-turn case, not a runtime regression; a longer `state-size` case would settle it. CPU per turn for state rewrites grows with the blob, from about 2.5 ms at 4 KiB to 10–14 ms at 60 KiB, because each `set` round-trips the whole state through its schema and each commit encodes and compresses it.

### Runner capacity and pool size (#39, #42)

[ADR 0019](../decisions/0019-runner-capacity-and-pool-size.md) adds `Actors.layer({ maxResidentActors })` (default 10,000) and the retryable `RunnerAtCapacity` reason, and it defaults `Database.postgres` to 50 connections. Its `many-actors` runs happened on a different VM from the files above. That VM has the same 4-vCPU EPYC shape but ran about twice as fast, so compare these files only with each other:

- `2026-09-25-f083e80-main-same-machine-postgres.json`: the harness at #38's head, without this change.
- `2026-09-25-281a4b3-runner-capacity-postgres.json`: this change. The 100k count runs with `maxResidentActors: 100000`. With the default, each of the 90,000 callers over the limit would retry for its whole 30-second delivery timeout.
- `2026-09-25-281a4b3-runner-capacity-repeat-postgres.json`: a repeat on the same SHA. It's marked `dirty` because documentation files were edited while it ran. No runtime or harness file changed.

| Case (64 callers)           | Without the change             | With it, run 1     | With it, repeat    |
| --------------------------- | ------------------------------ | ------------------ | ------------------ |
| first-touch-100000          | 155 op/s, 51,682 `MailboxFull` | 252 op/s, 0 errors | 240 op/s, 0 errors |
| steady-100000               | 142 op/s, 1,289 `MailboxFull`  | 244 op/s, 0 errors | 218 op/s, 0 errors |
| steady-10000, pool 10 (p99) | 509 ms                         | 535 ms             | 495 ms             |
| steady-10000, pool 25 (p99) | 901 ms                         | 495 ms             | 482 ms             |
| steady-10000, pool 50 (p99) | 228 ms                         | 212 ms             | 242 ms             |

First touch of 100k actors grew the heap by 1.0–1.8 GiB across the two runs. The run without the change grew it by 0.9 GiB, even though at most 10,000 actors were resident. This fits finding 5: memory follows actors touched, not actors resident. `steady-100000` still started a new activation for 89% of its turns. First touch took about 400 seconds, so most actors had already hibernated under the 60-second `hibernateAfter`. At 10k actors, 50 connections cut p99 by more than half against 10 connections in all three runs, and 25 connections gave no consistent gain. That's why the default is 50.

### Reducers, capacity, and owned-table ordering (#58)

`2026-09-25-8db29a9-coverage-{postgres,pglite}.json` runs `hot-actor`, `owned-rows`, `reducers`, and `capacity` on `main` `96eb5e1` plus the new scenarios, with Bun 1.3.14 on a 4-vCPU cloud VM. `hot-actor` in the same run is the baseline. `2026-09-25-bcd66a4-coverage-repeat-postgres.json` repeats the Postgres run on the same VM: every statement count matched, capacity throughput moved by at most 7%, and in the repeat reducers with 64 callers ran faster than commands (464 against 432 op/s). The Postgres figures:

- **Server reducers cost the same as a command handler.** A reducer that replies with the new state issues 7.01 statements per operation, like a `hot-actor` command turn, and the commutative reducer also issues 7.01. A reducer that fails with a declared error issues 6.01, because it commits a failure receipt and skips the state upsert. Statement counts are the machine-independent measure, and they match in both runs. Latency and throughput differ by less than the run-to-run noise: in the first run reducers were slower (p50 2.44 against 2.59 ms, but p95 8.1 against 5.0 ms and 296 against 339 op/s, and 379 against 411 op/s with 64 callers), and in the repeat they were level or faster (p50 2.29 against 2.36 ms, p95 5.1 against 4.6 ms, and 464 against 432 op/s with 64 callers). Reducers add no round trip, so the M1 reducer design needs no performance follow-up.
- **Past `maxResidentActors`, the idle sweep sets the pace.** With the limit at 1,000 and 64 callers on actors that hibernate after 250 ms, steady state over 1,000 actors ran at 514 op/s with no errors. Over 4,000 actors it fell to 175 op/s, p95 rose from 0.34 s to 2.8 s, and 99.4% of turns started a new activation. A caller over the limit waits for Cluster's idle sweep to evict a hibernated activation, and the sweep runs about every 5 seconds, so throughput past the limit is bounded by roughly the limit per sweep interval, not by the database. The CPU of both the runtime and Postgres fell, which confirms that callers were waiting rather than working. No caller hit its 30-second delivery timeout, but only because `SleepyProbe` hibernates after 250 ms: with the default `hibernateAfter` of 60 seconds, no slot frees for a minute and callers past the limit fail `RunnerAtCapacity` after their delivery timeout. Size `maxResidentActors` to the working set: the limit is a cliff, not a gradual slowdown.
- **An ordered owned-table read needs its own index.** The `owned-rows` page query (top 20 of 1,000 rows by `amount`) now reads an ownership-prefixed index on `amount`. Its statement went from 0.44 ms mean execution in `2026-09-25-2ee0bba-owned-rows-postgres.json` to 0.03 ms, because Postgres no longer reads and sorts every row of the actor. [Drizzle integration](../api/04-drizzle.md) now tells applications to declare that index.

On PGlite, which reports no statement counts, reducers ran at 197–202 op/s against 144 op/s for commands in the same run. They run the same turn code path, so treat that gap as unconfirmed noise rather than a reducer advantage. The capacity cases stayed near 200 op/s at and past the limit. PGlite's single connection tops out near that rate, which coincides with the sweep's ceiling of about 1,000 slots per 5 seconds, so this run can't separate the two. A `quick` run with a limit of 250 does show the sweep bound on PGlite: past the limit, steady-state throughput fell from 220 to 21 op/s (an uncommitted run on this VM).

### Recommendations (not applied)

These are runtime changes, so each belongs in its own pull request:

- Compute the payload hash and the database time once per command, instead of twice and three times. That removes three to four round trips from every command (#40, done: 14 to 10 round trips per warm turn).
- Report Cluster's never-cleared processed-request set under `MessageStorage.layerNoop` upstream (#46).
- Rerun `many-actors` after #41 and measure heap per resident activation before making any claim above 10k actors per runner.
- Add a measured stored-actor overhead case, using relation sizes after N actors, and several-runner cases before testing the per-shard turn hypothesis.
