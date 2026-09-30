# Performance and capacity

**Responsibility:** replace scaling assumptions with measurements.  
**Authority:** evidence.  
**Owner role:** performance/reliability.
**Change policy:** a change requires the conformance suite to be updated in the same change.

Benchmarks MUST measure command p50/p95/p99, hot-actor throughput, transaction duration, database round trips and pool waits, receipt/event/outbox growth, mailbox age, hibernation and wake latency, parked-connection memory, event replay lag, workflow resume latency, Neki relay lag, and recovery after runner death.

Capacity tests MUST include `State.maxBytes`, the 16 KiB connection-state limit, memory per parked connection at its holder, wake-on-frame latency, broadcast fan-out to 10^4 connections across runners, reauthorization calls per second at `policy.reauthorizeEvery`, cluster principal-header size, mailbox capacity, event retention, and reconnect waves. Singleton tests MUST show one active `run` and one cron tick across runner counts.

Every result MUST record runtime and backend versions, deployment mode, topology, database settings, indexes, dataset size, tenant/key skew, hardware, concurrency, durability settings, and injected failures. PGlite results MUST NOT be generalized to lock contention or multi-process Postgres/Neki behavior.

No estimate becomes a product claim without a reproducible command, fixture, raw result, and acceptance threshold.

## Planning envelope (hypotheses)

[ADR 0005](../decisions/0005-turn-latency-batching-and-regional-placement.md) and [ADR 0006](../decisions/0006-scale-rules-placement-and-query-tiers.md) size shards and set competitive targets from published benchmarks, not measurements of this runtime. Each number below is a hypothesis for the benchmarks that follow.

Measured values come from one 4-vCPU cloud VM with Postgres 18.6 on loopback TCP, not Neki, and from one runtime process ([results](#measured-results-2026-09-25)). They test whether this runtime reaches each number on that machine and say nothing about production capacity.

| Quantity                         | Hypothesis                                                        | Measured (one VM, local Postgres 18)                                                                                                                            | Status                                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable turns per shard          | 5,000–20,000/second; plan with 10,000                             | At most about 450 turns/second in total. The benchmark process saturates about one core while Postgres uses under half of one                                   | Untested: one runtime process cannot load the database, so several runners are needed                                                          |
| Usable data per shard            | 15 TB, below the 32 TB PostgreSQL relation limit                  | Not measured                                                                                                                                                    | Untested                                                                                                                                       |
| Stored actor overhead            | 175–250 bytes plus state                                          | About 400 bytes per actor (395–416 across runs) with a 10-byte state: generation and state rows with their primary-key indexes ([M1 close](#m1-close-cloud-vm)) | Missed: both rows and both primary keys repeat the four ownership columns, and the hypothesis left out indexes                                 |
| In-region warm write p50 on Neki | 3–6 ms with two round trips                                       | 3.1 ms p50 and 6.7 ms p99 on local Postgres, with 14 round trips                                                                                                | Neki untested. Two round trips missed: the turn issues 14. Latency is near the bottom of the range only because loopback round trips are cheap |
| Hot-actor throughput             | 150–400 commands/second unbatched; 2,000–10,000 with turn batches | 290/second with one caller; with turn batches, 612–686/second with 8 callers and 911–1,275/second with 64 ([P5](#turn-batches-p5-160))                          | Unbatched met, near the top of the range. Batched untested: turn batches are not implemented                                                   |
| Wake latency                     | 5–15 ms                                                           | First turn after hibernation: 3.7 ms p50, 9.0 ms p99. First turn of a never-seen actor: 4.0 ms p50, 9.4 ms p99                                                  | Met on local Postgres; p50 is below the range                                                                                                  |

Split a shard, or stop placing new keys on it, when any of these persists at normal peak: primary CPU above 60–70%; autovacuum not returning dead tuples to baseline between peaks; transaction-ID age approaching `autovacuum_freeze_max_age` faster than vacuum advances it; replica or relay lag rising; heap-only update ratio falling on framework tables.

## Required scale benchmarks

These run on dedicated hardware in [#66](https://github.com/Rika-Labs/durable-actors/issues/66), which no milestone waits on. The [M1 close](#m1-close-cloud-vm) pass on a cloud VM is not one of them.

- **Flat latency with stored actors:** a fixed 10,000 turns/second on one shard with 10^5, 10^7, and 10^9 stored actors. Turn p99, wake latency, and timer lateness must stay within 10% across the three.
- **Linear scale-out:** 1, 2, 4, 8, and 16 Neki shards with turns/second per shard held constant, including during an online reshard. Measure the single `cluster_*` shard group separately.
- **Hot-actor ceiling:** maximum durable commands/second for one actor with turn batches off and on.
- **Round trips:** database round trips per turn, expected to be two. The `Statements` CI job holds every pull request to `main` to the statements per operation in `benchmarks/baselines/statements.json`; a pull request that changes a count updates that file and says why ([benchmarks/README.md](../../benchmarks/README.md#statement-gate)).
- **72-hour soak:** vacuum progress, transaction-ID age, WAL bytes per turn, full-page-image ratio, replica lag, and relay lag.
- **Workflows** (ADR 0022; M2.7's `workflow` scenario): statements and milliseconds per recorded activity step, resume latency after a runner kill, sleep lateness against the due time, and recovery resume turns per running execution. The emit-path wait lookup must not change the statement count for actor types without waits.
- **Failure drills:** runner kill, shard primary failover, and relay crash, with recovery time and duplicate/lost-work checks.
- **Remote users:** p50/p99 for a tenant served from its home region versus from a remote single region. Deferred to L.1 ([ADR 0031](../decisions/0031-hosted-ingress-tenant-directory-and-regions.md)).
- **Content blobs** (M4.13, [ADR 0034](../decisions/0034-tenant-scoped-content-addressed-blobs.md)): deduplication ratio and bytes stored for a skewed upload set, upload and attach latency, read latency, and sweep cost per thousand candidates.
- **File-backed PGlite** (M4.14, [ADR 0035](../decisions/0035-pglite-embedded-production-backend.md)): turn and wake latency and throughput at several `dataDir` sizes; the largest measured size bounds the claim. Measured below under [Embedded PGlite](#embedded-pglite-m414).
- **Cold wakes** (L.2, [ADR 0036](../decisions/0036-cold-tier.md)): latency of a cold wake against the wake-latency target plus one object GET.
- **Scale-to-zero** (M6.7, [ADR 0062](../decisions/0062-scale-to-zero-serving.md); T15): the `cold-start` scenario reports warm served latency (`warm`) separately from cold drills. Each drill drains and stops the only runner, lets `due` intents come due with no runner (`cold-due-0`, and `cold-due-1000` in the full profile), then times the new runner's `/ready`, first answered command, and delivery of every due intent, all measured from the runner's start. The runner starts inside the benchmark process, so the platform's process boot is not included.

## M1 close (cloud VM)

This is M1.10 (#48): the benchmark suite on `main` at M1 close, run from clean trees on one cloud VM, with repeats in the same session to bound noise. It is not a scale run. The [required scale benchmarks](#required-scale-benchmarks) run on dedicated hardware in [#66](https://github.com/Rika-Labs/durable-actors/issues/66).

**Code.** `main` at `5e7a9ac` plus the harness changes on this branch: the new `stored-overhead` scenario, 10^6 sleeping timers in `outbox` (full profile), and a fix to the `blobs` append cases. No runtime code differs from `main` at `5e7a9ac`. Two harness SHAs ran:

- `ace686a`: `stored-overhead` and the 10^6 timers. Its `blobs/append-65536` and `append-1048576` cases fail (392 and 100 `Error`s) because the scenario appended to one entry past the 8 MiB entry cap that M1.9 (#17) added. Ignore those two cases in the `ace686a` files.
- `0efbf74`: the same plus the fix, which moves the growing entry to a fresh, already warm actor when it is full. Its append cases run without errors.

**Runs.** One session, one after another:

| File (`benchmarks/results/`)                      | Harness   | Backend       | Scenarios                    |
| ------------------------------------------------- | --------- | ------------- | ---------------------------- |
| `2026-09-28-ace686a-m1.10-close-r1-postgres.json` | `ace686a` | Postgres 18.6 | full profile, every scenario |
| `2026-09-28-ace686a-m1.10-close-r1-pglite.json`   | `ace686a` | PGlite 0.5.8  | full profile, every scenario |
| `2026-09-28-0efbf74-m1.10-close-r2-postgres.json` | `0efbf74` | Postgres 18.6 | full profile, every scenario |
| `2026-09-28-0efbf74-m1.10-close-r2-pglite.json`   | `0efbf74` | PGlite 0.5.8  | the scoped scenarios below   |
| `2026-09-28-0efbf74-m1.10-close-r3-postgres.json` | `0efbf74` | Postgres 18.6 | the scoped scenarios below   |

The scoped scenarios are the ones the M1.10 scope names: `hot-actor`, `cold-activation`, `query-latency`, `receipt-replay`, `state-size`, `many-actors`, `retained-heap`, `stored-overhead`, and `outbox`. So every Postgres case has two full runs and the scoped cases three; every PGlite case has one run and the scoped cases two. A full profile takes about three hours on Postgres and longer on PGlite, which is why the third run and the PGlite repeat cover only the scope.

**Where and how.**

- **Machine:** one Amp orb (E2B cloud VM) with 16 vCPUs (Intel Xeon @ 2.60 GHz, 8 cores with 2 threads each), 31.4 GiB of memory, Linux 6.1.158, no swap. The benchmark client, the actor runtime, and Postgres share its CPUs. This is a different and larger machine than the 4- and 8-vCPU VMs of the sections above, so compare these numbers only with each other.
- **Runtime:** one Bun 1.4.2 process with the benchmark client and the actor runtime, Effect `4.0.0-rc.116`, one runner except in `multi-runner` and `singleton-failover`.
- **Postgres:** 18.6 in Docker from the repository's `compose.yaml`, reached over loopback TCP through Docker's port proxy, as `BENCH_DATABASE_URL`. `compose.yaml` now preloads `pg_stat_statements` and gives the container 1 GiB of shared memory, as the harness's own container does. Every other setting is the default: `fsync`, `synchronous_commit`, and `full_page_writes` on, `shared_buffers` 128 MB, `work_mem` 4 MB, `max_connections` 100, `wal_level` replica. Each case gets a fresh database; the runtime pool has 10 connections unless a case says otherwise. Because the harness doesn't own this container, `cpu.server` is not recorded.
- **Data:** at most 10^5 actors, 10^6 sleeping timers, and 10^6 old receipts and events, uniform key choice, one tenant except `inspection-views` (100 tenants). No replica, no network hop, no Neki router, and no injected failure beyond the scenarios' own runner kills.
- **One interruption:** the orb was paused for several hours during run 1's `workflows/sleep-50ms` case on Postgres. The process resumed where it stopped; that case's latencies match run 2's, but treat its run-1 throughput as unreliable.

**Reading the tables.** Each cell is the median over the runs, with the lowest and highest run in brackets; with two runs the median is their mean. Statements per operation are the same in every run to within 0.2, so they're given once.

### Scope results

| Case                                                                                  | Runs | Throughput (op/s) |            p50 (ms) |          p99 (ms) | Statements/op |     PGlite p50 (ms) |
| ------------------------------------------------------------------------------------- | ---: | ----------------: | ------------------: | ----------------: | ------------: | ------------------: |
| Warm turn, one actor, one caller (`hot-actor/sequential`)                             |    3 |     219 (173–235) |    4.34 (4.09–5.51) |  9.22 (8.91–11.7) |          7.01 |    5.42 (4.76–6.08) |
| Hot actor, 8 callers (`hot-actor/concurrent-8`)                                       |    3 |     266 (193–294) |    29.3 (25.9–39.9) |  46.7 (46.4–62.9) |          7.01 |    44.2 (39.5–48.9) |
| Hot actor, 64 callers (`hot-actor/concurrent-64`)                                     |    3 |     287 (210–306) |       221 (204–298) |     281 (275–479) |          7.01 |       354 (318–390) |
| First turn of a new actor (`cold-activation/new-actor`)                               |    3 |     183 (167–192) |    4.88 (4.82–5.78) |  12.2 (11.9–17.7) |          9.01 |    6.88 (6.23–7.54) |
| First turn after hibernation (wake) (`cold-activation/after-hibernation`)             |    3 |    156 (70.8–170) |    5.85 (5.66–9.04) |  14.8 (11.7–64.9) |          9.01 |    6.58 (5.86–7.30) |
| Query, one caller (`query-latency/sequential`)                                        |    3 | 1,738 (445–1,747) | 0.550 (0.532–0.984) | 1.04 (0.804–14.3) |             1 | 0.712 (0.687–0.736) |
| Receipt replay, one caller (`receipt-replay/sequential`)                              |    3 |     601 (463–826) |    1.53 (1.15–1.98) |  4.08 (1.97–6.52) |             2 |    1.07 (1.04–1.09) |
| 64 callers over 10^4 warm actors (`many-actors/steady-10000`)                         |    3 |     608 (553–702) |    77.9 (65.9–83.7) |     436 (384–516) |             7 |       367 (353–382) |
| 64 callers over 10^5 actors (`many-actors/steady-100000`)                             |    3 |     408 (390–571) |      109 (79.9–114) |     719 (488–736) |     8.49–8.55 |             not run |
| 10^4 warm actors, pool of 50 (`many-actors/steady-10000-pool-50`)                     |    3 |     625 (612–714) |    93.5 (79.2–95.4) |     202 (184–221) |             7 |             not run |
| Intent delivery beside 10^4 sleeping timers (`outbox/delivery-beside-10000-timers`)   |    3 |  69.0 (61.5–93.9) |    13.4 (9.98–15.3) |  29.8 (17.9–33.9) |   14.13–14.14 |    15.3 (14.3–16.2) |
| Intent delivery beside 10^5 sleeping timers (`outbox/delivery-beside-100000-timers`)  |    3 |   77.5 (63.7–107) |    12.3 (8.91–15.2) |  19.7 (14.6–29.8) |   14.13–14.14 |    15.6 (15.3–16.0) |
| Intent delivery beside 10^6 sleeping timers (`outbox/delivery-beside-1000000-timers`) |    3 |  62.9 (58.6–90.8) |    15.2 (9.96–16.1) |  26.5 (23.0–33.7) |         14.13 |    16.1 (15.0–17.1) |

| Case                                               | Runs |            Postgres |              PGlite |
| -------------------------------------------------- | ---: | ------------------: | ------------------: |
| KiB per resident activation, 10^4                  |    3 |    22.7 (22.7–22.7) |    22.6 (22.6–22.6) |
| KiB per resident activation, 10^5                  |    3 |    22.8 (22.8–22.8) |             not run |
| KiB kept per touched actor after hibernation, 10^5 |    3 | 0.078 (0.078–0.078) |             not run |
| KiB kept per command after hibernation             |    3 | 0.041 (0.040–0.045) | 0.002 (0.000–0.004) |

- **Statements and round trips per turn.** A warm turn issues 7.01 counted statements, a first turn and a wake 9, a query 1, and a receipt replay 2, in every run. With `BEGIN`, `SAVEPOINT`, and `COMMIT`, which `pg_stat_statements` doesn't count per call, a warm turn is 10 round trips, as expected after #43. ADR 0005's two round trips are not reached on `main`; #130 is the change that targets them.
- **Hot actor and wake.** One caller gets 219 (173–235) turns per second on one actor, and 8 or 64 callers add about a third, because turns on one actor run one at a time and the process's CPU per turn (2.5–4.2 ms here) sets the pace. Turn batches don't exist, so the batched hypothesis stays untested. The first turn after hibernation takes 5.85 (5.66–9.04) ms at p50.
- **Due-work scan.** The relay's due-work scan probes the `(bucket, kind, due_at_ms)` index once per bucket, so timers that aren't due cost little: its mean execution time was 1.31 (1.13–1.59), 1.27 (1.03–1.83), 2.35 (1.76–2.84) ms with 10^4, 10^5, and 10^6 timers not yet due, per `pg_stat_statements`. The step to 10^6 adds under a millisecond, and one intent's delivery latency beside the timers didn't change beyond run-to-run noise. Statements per delivery stay at 14.13.
- **Many stored actors.** With 64 callers, steady state over 10^4 warm actors and over 10^5 actors ran at the throughputs above with no errors. Over 10^5 actors, 74–78% of steady-state turns started a new activation, because first touch takes longer than the 60-second `hibernateAfter`, so most actors had hibernated again. This is a VM-sized preview, not the flat-latency benchmark in #66.
- **Heap.** A resident activation holds 22.6–22.8 KiB of JavaScript heap, flat from 10^4 to 10^5 actors and across runs and backends, up from 19.5 KiB measured for #59 on `0ba95fc`. After hibernation the runner keeps 0.04–0.08 KiB per touched actor and about 0.04 KiB per command, as before.

### Stored bytes per actor

`stored-overhead` measures the on-disk growth of the runtime tables after n `Probe` actors each took one `Add` turn. `Probe` keeps a 10-byte state value.

| Backend, actors | Runs | Total per actor (B) | `actor_generations` heap / index (B) |   `actor_state` heap / index (B) | Receipt per turn (B) |
| --------------- | ---: | ------------------: | -----------------------------------: | -------------------------------: | -------------------: |
| Postgres, 10^4  |    3 |       412 (397–416) |     143 (138–149) / 75.4 (75.4–81.1) | 111 (108–111) / 76.2 (76.2–80.3) |        481 (479–482) |
| Postgres, 10^5  |    3 |       399 (395–413) |     136 (135–152) / 76.9 (76.7–78.6) | 107 (107–107) / 77.7 (77.0–78.0) |        472 (471–473) |
| PGlite, 10^4    |    2 |       411 (411–411) |     150 (150–150) / 78.6 (78.6–78.6) | 106 (106–106) / 76.2 (76.2–76.2) |        481 (481–481) |

- **The 175–250 B hypothesis is missed.** One stored actor with a 10-byte state takes about 400 (395–416) bytes across its generation row, its state row, and their primary-key indexes. The heap rows are wider than the hypothesis assumed: both tables repeat the four ownership columns (`routing_key`, `tenant_id`, `actor_type`, `actor_id`) and use `fillfactor = 80`, and each primary key repeats the ownership columns again, so the two indexes alone take about 155 bytes. The hypothesis did not include indexes.
- **Receipts are extra.** Each command leaves a receipt of about 475 bytes, table and index, until its horizon. An actor that took k commands inside the receipt horizon stores about k × 475 bytes of receipts beside its fixed rows.
- The numbers agree on PGlite, whose storage format is the same, and between 10^4 and 10^5 actors.

### Everything else

The remaining cases ran in both full Postgres runs and the full PGlite run. Their statements per operation match between runs to within 0.2 (except `workflows`, whose statement count includes a finish poll that runs a varying number of times). Their latencies are in the result files; `bun run bench:compare` lines up two of them. Notes:

- **Run-to-run noise is larger on this VM than on the earlier ones.** Run 2 was slower than run 1 in most cases, by up to about 70% at p50 for sequential cases (for example `blobs/set-4096`, 3.9 against 6.5 ms), with statement counts identical. Nothing changed in the runtime between them, so the spread reflects the shared cloud VM and is the noise floor for comparing any single run from it. Tail percentiles and one-caller throughput move the most.
- **`capacity` past the limit** still hits the idle-sweep cliff: p99 about 4 seconds once actors outnumber `maxResidentActors` 4 to 1, as #58 recorded.
- **`retention`** swept 10^6 receipts and 10^6 events in about three minutes (about 11,000 rows per second), and warm turns during the sweep kept their idle tail.
- **`workflows/sleep-50ms`** resumes about 1 second after the call, bounded by the relay's 1-second poll, as before.
- **`multi-runner/kill-1-of-3`** logs `Outbox relay pass failed` with a connection error around the kill; every command in the case succeeded.

### Not covered

- **Anything at scale.** Flat latency at 10^5, 10^7, and 10^9 stored actors, linear scale-out across shards and runner processes, the hot-actor ceiling at scale, the 72-hour soak (vacuum, transaction-ID age, WAL bytes per turn, replica and relay lag), failure drills at scale, and remote users are in [#66](https://github.com/Rika-Labs/durable-actors/issues/66), on dedicated hardware.
- **Neki.** Every number here is single-node Postgres on loopback. Round trips cost more over a network or through a Neki router.
- **Separate hosts and processes.** The client, the runtime, and Postgres shared one VM; `multi-runner` runs its runners in one process. No number here is a per-process or per-host capacity.
- **Server CPU.** Not recorded, because Postgres ran from `compose.yaml` rather than the harness's own container.
- **Turn batches.** Not implemented, so the batched hot-actor hypothesis stays untested.
- **Durable turns per shard** (5,000–20,000/second). One runtime process reaches about 600–700 turns per second over many actors here. The sections below found that ceiling in the runtime process, not the database; without server CPU this pass can't confirm it. #66 measures it with several processes.
- **Larger states and indexes.** `stored-overhead` measures a 10-byte state and the runtime's own tables only; owned tables, blobs, events, and outbox rows add their own bytes.
- **PGlite limits.** PGlite has one in-process connection; its results bound local development and say nothing about lock contention or multi-process behavior.

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

### Actor blobs (M1.blob)

Two full runs of `hot-actor`, `state-size`, and `blobs` on `feat/30-blobs` at `cc6c43e`, one machine, Postgres 18.6. Each p50 pair is run / repeat, in ms:

| Entry  | `set`     | `append`  | `read` (1 chunk / 16 chunks) | `compact` 16 chunks |
| ------ | --------- | --------- | ---------------------------- | ------------------- |
| 4 KiB  | 4.7 / 6.1 | 2.9 / 3.0 | 0.46 / 0.42 · 0.47 / 0.42    | 3.1 / 3.1           |
| 64 KiB | 3.6 / 7.9 | 4.5 / 5.0 | 0.62 / 1.5 · 0.66 / 0.80     | 3.5 / 3.7           |
| 1 MiB  | 26 / 24   | 23 / 20   | 8.3 / 8.3 · 9.6 / 7.6        | 25 / 23             |

- **Statements:** a blob `set`, `append`, or `compact` turn issues 11 statements, the same as a warm state-only turn: the blob statement replaces the state write. A query read issues 2. These counts are the regression gate.
- **Chunking is nearly free to read:** a 16-chunk entry reads as fast as a one-chunk entry at every size, because `string_agg` joins the chunks in the database.
- **Append does not rewrite earlier bytes:** at 4 KiB an append turn (2.9 ms) costs the same as a warm state turn (3.0 ms), where `set` pays for rewriting chunk 0.
- **1 MiB entries** take about 25 ms to write and 8 ms to read on Postgres, and about 90 ms and 53 ms on PGlite. Most of it is moving the bytes, since statement counts barely change.

**The DURA-17 16–32 KiB lead does not show up as a blob-specific cost.** Blob `set` p50 at 16 and 32 KiB was 4.1 and 7.2 ms in the first run, and 3.1 and 3.4 ms in the repeat. An earlier run on `f6fe7f8` gave 3.4 and 3.5 ms. In the same runs, the state-size rewrite at 32 KiB was 10.9 and 5.6 ms. So both mechanisms show the same run-to-run jump at 32 KiB. It is noise on this VM or a shared effect that isn't blob-specific, and statement counts stay flat. The one-caller `set` p50 at 4 and 64 KiB also varies by up to 2x between runs. Treat single-run latency here as noise and gate on statements.

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
   - **Cluster's processed request ids (#46):** Cluster's entity manager records every request id it answers in a set that only its storage-read loop clears, and Sharding starts that loop for any message storage except `MessageStorage.noop`. Under `MessageStorage.layerNoop` the set kept every command's id for the runner's lifetime: the heap conformance case measured 1.02 objects per command on Postgres 18.6, and the standalone reproduction in the issue 94 bytes, roughly 1 GiB per 10 million commands. The runtime now provides `directMessages`, which stores nothing, as `noop` does, but is a different instance, so the loop runs every `entityMessagePollInterval` (10 s), reads nothing, and clears the set; retention is bounded by the commands of one poll interval, and the same case measures −0.10 objects and −3 bytes per command. Receipts stay the deduplication record: the set never deduplicated a caller's retry, which is a new Cluster request with the same command id, and a request id delivered again after a poll is admitted and answered from its receipt. Persisting a Cluster message still dies. The set is still unbounded inside Effect for any application that uses `layerNoop` itself; reporting it upstream remains open.
   - **Re-measured (#59):** a resident activation holds about 19.5 KiB and 263 objects of heap, the same at 10k and 100k actors; see "Activation residency and pools across runners" below. That accounts for the 15–50 KiB per activation seen during first touch together with the retained client the fix removed.
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

### Activation residency and pools across runners (#59)

`2026-09-27-fe0f6f6-p2-residency-postgres.json` and its same-VM repeat `2026-09-27-0a55dc6-p2-residency-repeat-postgres.json` run `many-actors`, `retained-heap`, and `multi-runner` on Postgres 18.6; `2026-09-27-0a55dc6-p2-residency-pglite.json` runs the first two on PGlite 0.5.8. The two SHAs differ only in documentation merged from `main`. Bun 1.4.2 on an 8-vCPU Xeon Platinum 8559C VM with 31 GiB, with the benchmark client, runtime, and Postgres sharing its CPUs. The repeat ran slower in most cases, by up to 38% in throughput, so compare latencies within a run, not across them.

**Heap per resident activation.** `retained-heap/resident-<n>` first-touches n `ResidentProbe` actors, which hibernate after an hour, and measures the heap after a forced garbage collection while every activation is still resident:

| Case              | KiB per actor (run, repeat) | Objects per actor | PGlite       |
| ----------------- | --------------------------: | ----------------: | ------------ |
| `resident-10000`  |                19.53, 19.53 |             263.0 | 19.43, 261.3 |
| `resident-100000` |                19.56, 19.57 |             263.0 | not run      |

The per-actor cost is flat from 10k to 100k and within 0.6% between runs and backends. The object types point at per-activation closures and bookkeeping rather than state: per actor, about 85 plain objects, 68 functions, 37 closure environments, and 9 maps and arrays. After hibernation the same runner keeps 0.045–0.078 KiB and under one object per touched actor (`touch-<n>`), and 0.045–0.047 KiB per command sent to one actor (`one-actor-10000`), no more than the 0.09–0.11 KiB recorded after the #41 fix. RSS per actor is not a usable measure here: across the two resident cases it ranged from −19 to +26 KiB, because the allocator returns and reuses pages independently of the heap.

**The `maxResidentActors` default stays 10,000.** At 19.5 KiB each, 10,000 resident activations hold about 190 MiB of heap, and 100,000 hold about 1.9 GiB before the state they cache and the rest of the process. `resident-100000` ran with the limit raised to 101,000 and completed without errors, so the limit is a memory budget, not a throughput ceiling. A higher default would make an out-of-memory crash, instead of the typed, retryable `RunnerAtCapacity`, the failure on a small container. Deployments with the memory can raise it; the API reference says so already.

**Connections and latency across runners.** `multi-runner/runners-<n>` runs 64 callers over 256 actors through `ActorTest.cluster`, whose runners each open a pool of 10 connections:

| Runners | Throughput (op/s) | p50 (ms)    | p95 (ms)      | p99 (ms)      | Peak connections | Per runner |
| ------: | ----------------: | ----------- | ------------- | ------------- | ---------------: | ---------: |
|       1 |       1,439 / 966 | 32.5 / 46.8 | 123.1 / 188.1 | 187.5 / 304.0 |               11 |       11.0 |
|       2 |       1,207 / 818 | 40.1 / 55.1 | 135.5 / 215.1 | 196.6 / 324.5 |               21 |       10.5 |
|       4 |     1,194 / 1,018 | 53.1 / 60.7 | 90.0 / 108.9  | 105.0 / 135.9 |               41 |       10.3 |
|       8 |       1,144 / 851 | 55.2 / 72.8 | 97.2 / 139.4  | 110.5 / 173.3 |               81 |       10.1 |

Values are run / repeat. Every runner filled its pool and no more, so peak connections were runners × 10 plus one connection outside the runners' pools, in both runs. That is the sizing rule in [deployment](../operations/01-deployment.md#postgres-connections-across-runners): `runners × maxConnections` plus reserved connections must fit in `max_connections`. Adding runners raised p50, since most calls cross the in-process transport to another runner. It lowered p95 and p99, because more runners bring more pooled connections in total, so fewer callers queue for one. All runners share one process and its CPU, so these numbers show how connections add up, not separate processes' latency. Statements per operation stayed at 7.00–7.02 for every runner count.

**Pool size on one runner.** With 64 callers over 10,000 warm actors, `steady-10000-pool-50` had a p99 of 96 and 130 ms against 179 and 166 ms for `pool-25`, and the default 10 connections gave 822 and 432 ms. The default of 50 stays.

**Statements are unchanged:** 9.00–9.03 per first touch, 7.00 per warm turn, and 8.07–8.11 for `steady-100000`, whose turns mix 53–55% new activations with warm ones.

### Reducers, capacity, and owned-table ordering (#58)

`2026-09-25-8db29a9-coverage-{postgres,pglite}.json` runs `hot-actor`, `owned-rows`, `reducers`, and `capacity` on `main` `96eb5e1` plus the new scenarios, with Bun 1.3.14 on a 4-vCPU cloud VM. `hot-actor` in the same run is the baseline. `2026-09-25-bcd66a4-coverage-repeat-postgres.json` repeats the Postgres run on the same VM: every statement count matched, capacity throughput moved by at most 7%, and in the repeat reducers with 64 callers ran faster than commands (464 against 432 op/s). The Postgres figures:

- **Server reducers cost the same as a command handler.** A reducer that replies with the new state issues 7.01 statements per operation, like a `hot-actor` command turn, and the commutative reducer also issues 7.01. A reducer that fails with a declared error issues 6.01, because it commits a failure receipt and skips the state upsert. Statement counts are the machine-independent measure, and they match in both runs. Latency and throughput differ by less than the run-to-run noise: in the first run reducers were slower (p50 2.44 against 2.59 ms, but p95 8.1 against 5.0 ms and 296 against 339 op/s, and 379 against 411 op/s with 64 callers), and in the repeat they were level or faster (p50 2.29 against 2.36 ms, p95 5.1 against 4.6 ms, and 464 against 432 op/s with 64 callers). Reducers add no round trip, so the M1 reducer design needs no performance follow-up.
- **Past `maxResidentActors`, the idle sweep sets the pace.** With the limit at 1,000 and 64 callers on actors that hibernate after 250 ms, steady state over 1,000 actors ran at 514 op/s with no errors. Over 4,000 actors it fell to 175 op/s, p95 rose from 0.34 s to 2.8 s, and 99.4% of turns started a new activation. A caller over the limit waits for Cluster's idle sweep to evict a hibernated activation, and the sweep runs about every 5 seconds, so throughput past the limit is bounded by roughly the limit per sweep interval, not by the database. The CPU of both the runtime and Postgres fell, which confirms that callers were waiting rather than working. No caller hit its 30-second delivery timeout, but only because `SleepyProbe` hibernates after 250 ms: with the default `hibernateAfter` of 60 seconds, no slot frees for a minute and callers past the limit fail `RunnerAtCapacity` after their delivery timeout. Size `maxResidentActors` to the working set: the limit is a cliff, not a gradual slowdown.
- **An ordered owned-table read needs its own index.** The `owned-rows` page query (top 20 of 1,000 rows by `amount`) now reads an ownership-prefixed index on `amount`. Its statement went from 0.44 ms mean execution in `2026-09-25-2ee0bba-owned-rows-postgres.json` to 0.03 ms, because Postgres no longer reads and sorts every row of the actor. [Drizzle integration](../api/04-drizzle.md) now tells applications to declare that index.

On PGlite, which reports no statement counts, reducers ran at 197–202 op/s against 144 op/s for commands in the same run. They run the same turn code path, so treat that gap as unconfirmed noise rather than a reducer advantage. The capacity cases stayed near 200 op/s at and past the limit. PGlite's single connection tops out near that rate, which coincides with the sweep's ceiling of about 1,000 slots per 5 seconds, so this run can't separate the two. A `quick` run with a limit of 250 does show the sweep bound on PGlite: past the limit, steady-state throughput fell from 220 to 21 op/s (an uncommitted run on this VM).

### Promise client over HTTP (#93)

`2026-09-27-0e82396-m3.4-client-{postgres,pglite}.json` runs the `http` scenario (`bun run bench --scenario http --label m3.4-client`, full profile, one run per backend) with Bun 1.4.2 on an 8-vCPU cloud VM that also hosts Postgres 18.6. Each case runs first through raw `fetch` with an id minted from the `/protocol` offset, then through `@durable-actors/core/client` against the same `Actor.serve`. An earlier full Postgres run on the same VM at `2bf9b7b` is the noise reference: the client cases there were within 5% on throughput (682.6 against 695.3 op/s with 64 callers).

| Postgres case                  | raw `fetch` op/s | p50 / p95 / p99 ms   | client op/s | p50 / p95 / p99 ms   | stmts/op |
| ------------------------------ | ---------------- | -------------------- | ----------- | -------------------- | -------- |
| command, sequential            | 487.6            | 1.88 / 3.43 / 4.69   | 451.1       | 2.06 / 3.42 / 4.95   | 6.01     |
| query, sequential              | 1777.4           | 0.48 / 0.97 / 1.93   | 1628.6      | 0.54 / 0.93 / 2.02   | 1        |
| command, 64 callers, 1k actors | 944              | 60.3 / 132.2 / 175.4 | 695.3       | 82.4 / 176.1 / 244.4 | 6        |
| command, sequential, 1% loss   |                  |                      | 323.2       | 1.94 / 3.30 / 13.42  | 6.03     |

- **The client adds no database work.** Statements per operation match raw `fetch` in every case; a lost response costs one replayed receipt read, 0.03 statements per operation at 1% loss, and `duplicateTurns` was 0 on both backends.
- **Sequential calls cost about 0.1–0.2 ms more at p50**, the client's schema encode, envelope decode, and clock bookkeeping. With 64 concurrent callers the client ran 26% slower, because the benchmark client, runtime, and Postgres share 8 CPUs and the client spends 1.95 against 1.46 ms of CPU per operation. A client on another machine would not compete with the runtime for that CPU; this run does not measure that.
- **At 1% loss, p99 absorbs the retries.** Each lost response waits the first 100 ms backoff step, so p99 rose to 13.4 ms while p50 did not move.

On PGlite the single connection sets the pace and the client matches raw `fetch` within noise: 264.8 against 262.2 op/s for sequential commands, 827.3 against 904.6 for queries, 288.9 against 318.7 with 64 callers, and 208.2 op/s at 1% loss.

### Served HTTP/2 beside HTTP/1.1 (#122)

`2026-09-28-0359851-m3.2-http2-{postgres,pglite}.json` and the same-SHA repeat `2026-09-28-0359851-m3.2-http2-repeat-{postgres,pglite}.json` run the `http` scenario (`bun run bench --scenario http --label m3.2-http2`, full profile) with Bun 1.4.2 on a 16-vCPU Xeon (2.6 GHz) orb VM that also hosts the Postgres 18.6 container. Each `h2-*` case serves the same `Actor.serve` handler over cleartext HTTP/2 from Bun's `node:http2` server and sends raw requests as streams on one `node:http2` client connection shared by every caller; the HTTP/1.1 cases use `Bun.serve` and `fetch`, which opens a keep-alive connection per concurrent caller. Neither run had errors, and `duplicateTurns` under 1% loss was 0.

| Postgres case (run / repeat)   | HTTP/1.1 op/s | HTTP/1.1 p50 / p95 / p99 ms                  | HTTP/2 op/s   | HTTP/2 p50 / p95 / p99 ms                  | stmts/op |
| ------------------------------ | ------------- | -------------------------------------------- | ------------- | ------------------------------------------ | -------- |
| command, sequential            | 196.9 / 194.8 | 4.88 / 6.81 / 10.41, 4.96 / 7.17 / 10.64     | 201.6 / 209.3 | 4.79 / 6.71 / 10.60, 4.64 / 6.28 / 9.92    | 6.01     |
| query, sequential              | 788.5 / 779.4 | 1.20 / 1.57 / 4.24, 1.22 / 1.58 / 4.42       | 889.6 / 879.7 | 1.07 / 1.39 / 2.24, 1.09 / 1.43 / 2.05     | 1        |
| command, 64 callers, 1k actors | 550.3 / 579.1 | 106.0 / 213.9 / 278.8, 101.2 / 203.9 / 263.8 | 644.5 / 655.2 | 90.3 / 183.7 / 254.0, 89.9 / 180.9 / 231.7 | 6        |
| command, ES256 JWT             | 180.3 / 181.9 | 5.31 / 7.57 / 11.03, 5.28 / 7.39 / 11.10     | 197.6 / 192.8 | 4.88 / 6.60 / 10.06, 5.03 / 6.64 / 10.01   | 6.01     |
| command, largest principal     | 180.0 / 176.5 | 5.40 / 7.28 / 11.34, 5.48 / 7.68 / 11.34     | 210.2 / 195.9 | 4.54 / 6.55 / 9.67, 4.92 / 6.84 / 10.18    | 6.01     |
| command, 64 KiB payload        | 146.3 / 144.7 | 6.43 / 10.13 / 13.61, 6.50 / 10.13 / 14.60   | 144.1 / 151.8 | 6.55 / 10.42 / 13.99, 6.12 / 10.20 / 13.65 | 6.01     |

- **The protocol adds no database work.** Statements per operation are identical over HTTP/1.1 and HTTP/2 in every case, and equal to the embedded path's, so the transport is all the difference.
- **HTTP/2 was never slower, and faster with concurrent callers.** With 64 callers over 1,000 actors on one multiplexed connection it ran 13–17% more operations per second than 64 HTTP/1.1 keep-alive connections, with p50 about 90 ms against 101–106 ms, and used 1.9–2.0 ms of CPU per operation against 2.5–2.7 (the benchmark client and the runtime share one process, so that is both sides). Sequential queries ran 13% faster with half the p99 (2.1–2.2 against 4.2–4.4 ms). Sequential commands, which spend most of their time in the database, differ by less than the run-to-run noise.
- **Credentials and payload.** An ES256 JWT added 0.3–0.4 ms at p50 over `Actor.auth.none` on HTTP/1.1 and 0.1–0.4 ms on HTTP/2. The largest principal (a 1 KiB encoded caller from a custom provider) added 0.5 ms at p50 on HTTP/1.1 in both runs, and between −0.25 and +0.28 ms on HTTP/2. A 64 KiB body added 1.5–1.8 ms at p50 on either protocol.
- **What this doesn't isolate.** The two paths differ in both the server (Bun's native `Bun.serve` against `node:http2` plus an adapter that buffers each stream into a web `Request`) and the client (`fetch` against `node:http2` streams), so the numbers show that `Actor.serve` works over HTTP/2 and is no slower there, not the cost of HTTP/2 framing alone. The HTTP/2 is cleartext with prior knowledge; browsers speak HTTP/2 only over TLS, and TLS is not measured on either protocol.

On PGlite the single connection sets the pace and both protocols ran within noise of each other at 64 callers (195.8 and 202.8 op/s over HTTP/2 against 196.5 and 203.2 over HTTP/1.1), but HTTP/2's tail was longer: p99 512–514 ms against 333–379 ms, in both runs. Sequential HTTP/2 cases were faster: commands by 7% (190.9 and 190.3 against 177.8 and 178.7 op/s) and queries by 14–19% (751.2 and 739.1 against 631.7 and 647.3). The longer PGlite tail was not investigated further; on Postgres, where connections are pooled, HTTP/2's tail was shorter.

### Cross-actor subscriptions baseline

[ADR 0026](../decisions/0026-cross-actor-event-subscriptions.md) measures hand-rolled fan-out before subscriptions exist: one publisher turn that stages one intent per subscriber, due in a day, so only the publisher's turn is timed. The handler generates the ids, so the payload doesn't grow with n ([`addc1db-adr-0026-baseline`](../../benchmarks/results/2026-09-26-addc1db-adr-0026-baseline-postgres.json), with a same-SHA repeat). On Postgres the publisher's turn p50 is 2.5 ms with 1 subscriber, 33 ms with 256, and 83–86 ms with 1,024. With 16 subscribers it was 8.9 ms in one run and 4.2 ms in the repeat. Statements per turn stay at 8.0–8.2, and runtime CPU per turn tracks the latency, at about 80 µs per staged intent. Subscriptions move fan-out to the relay, so the #94 build must hold the publisher's turn flat across subscriber counts.

### Cross-actor subscriptions (M3.7, #94)

The `subscriptions` scenario now also runs the built feature ([`b63a32a-m3.7-subscriptions`](../../benchmarks/results/2026-09-28-b63a32a-m3.7-subscriptions-postgres.json), full profile, Postgres 18.6 with `pg_stat_statements`, one orb VM shared with the runtime and the driver). `publish-with-<n>-subscribers` gives one publisher `n` subscriptions of a subscriber type no runner registers, so the relay expands its feed after every commit but no delivery turn competes with the timed publisher.

| Case                                                      | p50 / p99 (ms)           | Rate                 | Statements per operation |
| --------------------------------------------------------- | ------------------------ | -------------------- | ------------------------ |
| `intent-fanout-1` / `-1024` (hand-rolled baseline)        | 3.1 / 7.6 → 56.3 / 155.7 | 289 → 16 publishes/s | 8.0 → 8.1                |
| `publish-with-1-subscribers`                              | 3.9 / 8.6                | 252 publishes/s      | 10.0                     |
| `publish-with-16-subscribers`                             | 3.8 / 8.9                | 250 publishes/s      | 10.0                     |
| `publish-with-256-subscribers`                            | 3.1 / 8.2                | 292 publishes/s      | 9.6                      |
| `publish-with-1024-subscribers`                           | 3.3 / 49.0               | 216 publishes/s      | 9.9                      |
| `commit-to-delivery` (one routed subscriber)              | 21.6 / 46.0              | 43/s                 | 23                       |
| `pair-throughput` (2,000 events, one pair)                | —                        | 70 events/s          | —                        |
| `fan-in-10000` (10^4 sources, one subscriber, 64 callers) | 1,045 / 1,504            | 70 events/s          | 23                       |
| `subscribe-churn`                                         | 3.9 / 11.6               | 230 changes/s        | 11.5                     |
| `drain-8192` (64 subscribers)                             | —                        | 513 deliveries/s     | —                        |

- **The publisher's turn is flat in subscriber count.** p50 stays at 3.1–3.9 ms from 1 to 1,024 subscriptions, where hand-rolled fan-out grows from 3.1 to 56 ms. The statements per publish above the T2 `events/append-1` baseline of 8 are the relay's feed claims and expansions that run during the window, not the publisher's; the publishing turn itself keeps its statement count. The 1,024 case's p99 is the expansion of 1,024 rows competing for the same CPU.
- **Delivery costs several relay passes.** A commit wakes the relay, which claims the feed, expands it, claims the now-due row, delivers the turn, and settles; commit-to-delivery p50 is about 22 ms here, and one pair runs at about 70 events per second, as ADR 0026 expects of a sequential pair. The ADR's lease-in-expansion step saves one claim pass; see the follow-up below.
- **Fan-in is bounded by the subscriber's turn rate,** as ADR 0026 notes; turn batches (P5) raise it.

### Cross-actor subscriptions: lease-in-expansion, wake, and a poison row (M3.7, #94)

[`7a69c3b-m3.7-subscription-followups`](../../benchmarks/results/2026-09-28-7a69c3b-m3.7-subscription-followups-postgres.json) reruns the scenario after lease-in-expansion, on main's pipelined turn (full profile, Postgres 18.6, same orb VM). The expansion now leases the rows it makes due that this runner delivers, up to its free delivery slots, and starts them without a claim pass.

| Case                                                                 | p50 / p99 (ms)                | Rate             | Statements per operation |
| -------------------------------------------------------------------- | ----------------------------- | ---------------- | ------------------------ |
| `commit-to-delivery` (one routed subscriber)                         | 13.8 / 24.6 (was 21.6 / 46.0) | 68/s (was 43/s)  | 33                       |
| `commit-to-delivery-hibernated` (`hibernateAfter: 100 ms`)           | 13.6 / 23.9                   | 67/s             | 35.5                     |
| `lag-without-poison-row` (63 followers × 128 events)                 | —                             | 582 deliveries/s | —                        |
| `lag-with-one-poison-row` (the same, plus one always-dying follower) | —                             | 551 deliveries/s | —                        |
| `prune-beside-0-subscriptions` / `-10000` (10^4 events)              | 79 / 131 (one pass)           | —                | 174 / 175                |

- **Lease-in-expansion cuts commit-to-delivery by a third.** p50 falls from about 22 to 14 ms and p99 from 46 to 25 ms: the delivery starts from the expansion instead of waiting for the relay's next claim.
- **Waking a hibernated subscriber adds nothing measurable** at this scale: the trip, including the new activation, stays at about 14 ms.
- **A poison row doesn't hold its neighbours back.** Beside one follower whose handler always dies, the other 63 drain the same backlog about 5% slower. The poison row backs off on its own, as the per-row hold requires.
- **An expansion page is bounded by its key range.** A first run of the full profile stalled in `prune-beside-10000-subscriptions`. With 10^4 freshly seeded rows and no statistics yet, the planner joined the expansion page to `actor_subscriptions` as a nested loop and rescanned the page for every stored row, about 10^7 comparisons per statement. The updates now bound their rows by the page's key range, and the page and leased set are materialized.
- **Metrics:** M4.3 emits the subscription metrics ADR 0026 names, as `durable-actors.subscription.lag_events`, `.lag_ms`, `.pinned_events`, and `.undeliverable_gaps`, and `durable-actors.relay.stuck_rows` ([ADR 0049](../decisions/0049-observability-names-metrics-and-defect-spans.md)).

### Effect cancellation and per-actor caps (M2.13)

`2026-09-27-7dd0260-m2.13-run{0..5}-postgres.json` runs `effect-concurrency` on Postgres 18.6, Bun 1.4.2, three in-process runners, on one 8-vCPU host (Xeon Platinum 8559C, 31 GiB) shared by client, runtime, and database. Command: `bun run bench --scenario effect-concurrency --backend postgres --profile full --label m2.13-run<i>`. Run 0 is the warm-up and contributes to none of the figures below: every median, range, and coefficient of variation (CV) is over runs 1–5 only. Statements are counted with `pg_stat_statements`; each is one round trip. Start latency is due-to-start: from the reply to the performing turn, which follows its commit and so the effect becoming due, to the fake provider seeing the attempt. The earlier `959da2f` runs timed start from before the performing command and are superseded; their other figures agree with these within noise.

| Case                         | Metric                                 | Median                   | Range             | CV     |
| ---------------------------- | -------------------------------------- | ------------------------ | ----------------- | ------ |
| uncapped                     | effects/s                              | 1,890                    | 1,834–1,932       | 2.2%   |
| uncapped                     | start p50 / p95 / p99 ms               | 205 / 260 / 283          | p99 268–300       | 2–5%   |
| uncapped                     | most in flight per actor               | 10                       | 10                | 0%     |
| uncapped                     | statements per effect                  | 4.46                     | 4.38–4.46         | 0.7%   |
| `perActor: 2`                | effects/s                              | 523                      | 402–545           | 10.5%  |
| `perActor: 2`                | start p50 / p95 / p99 ms               | 669 / 1,311 / 1,501      | p99 1,389–2,442   | 11–24% |
| `perActor: 2`                | most in flight per actor               | 2                        | 2                 | 0%     |
| `perActor: 2`                | statements per effect                  | 12.35                    | 12.18–12.40       | 0.6%   |
| hot actor, `perActor: 1`     | hot effects/s                          | 16.3                     | 16.1–16.3         | 0.5%   |
| hot actor, `perActor: 1`     | cold-actor start p50 / p95 / p99 ms    | 127 / 174 / 204          | p99 168–473       | 5–44%  |
| cancel, default check (20 s) | cancel-to-interrupt p50 / p95 / p99 ms | 19,195 / 20,050 / 20,080 | p50 19,073–19,619 | 1.0%   |
| cancel, 1 s check            | cancel-to-interrupt p50 / p95 / p99 ms | 1,095 / 1,436 / 1,476    | p50 1,073–1,953   | 27–34% |

- **The cap holds.** No actor ever had more attempts in flight than its cap in any run, across three runners, and no case recorded an error.
- **A capped claim costs about three times the statements of an uncapped one.** 12.3 against 4.5 statements per effect, and about a quarter of the throughput. The cap itself is not the limit here (2 in flight × 20 calls/s per actor would allow far more): each capped claim takes a transaction and an advisory lock per `(actor, tag)` group, so claiming is per group rather than one batch. Claims that group many actors per transaction are the obvious follow-up if capped throughput matters.
- **A hot actor does not starve cold ones.** With one actor holding 1,000 queued effects at `perActor: 1`, it ran at 16 effects/s (50 ms provider, so near its 20/s ceiling) while the other 1,000 actors' effects started at p50 127 ms after becoming due.
- **Cancel latency is the cancel check.** A cancellation committed on a runner without executors reaches the running attempt at the next renewal check: about 20 s at the default (lease 60 s / 3) and about 1 s at `cancelCheck: "1 second"`. One of the five 1-second runs was slow (p50 1,953 ms, statements per operation 22.7 against 15.1–16.9) and drives its CV to about 30%; the other four had p50 1,073–1,197 ms. The default-to-1-second difference (about 17×) is far beyond twice either CV. Differences below twice the CV in these tables, such as start-latency tails, are noise on a shared host.

### Query read path (#77)

After the M1 merges, `query-latency` on PGlite ran about 35% slower than before them: p50 rose from 0.37–0.40 ms to about 0.60 ms, with one statement per query throughout. Two alternating PGlite runs of `query-latency` and `receipt-replay` at each M1 merge on `main` (`48aa44e`, `e0a7915`, `238a0f8`, `7015670`, `3beaa25`, `f324a40`, `96eb5e1`, `0ba95fc`) put the whole step at `3beaa25`, the events merge. That merge made the query statement read the event head from `actor_generations` together with `actor_state`, so state and replay describe one committed moment. The same runs on Postgres showed no step larger than run-to-run noise, and three alternating runs of `receipt-replay` found `0ba95fc` no slower than `96eb5e1` there.

The joined statement was the cost. Timed alone on PGlite over 5,000 calls after 500 warm-up calls, three rounds, a bare `SELECT 1` took 100–120 µs, the state-only read 160–215 µs, and the joined read 385–425 µs; its planning time under `EXPLAIN ANALYZE` was 0.23 ms against 0.08 ms for one index lookup. The query now reads the same rows as a `UNION ALL` of the two primary-key lookups, still one statement and one snapshot, which halves the planning time (0.16 ms on PGlite, 0.13 to 0.07 ms on Postgres) and took 280–380 µs in the same timing. State rows count only when the generation row is present, as with the join.

Three runs a side, alternating before (`0ba95fc`) and after (`b020f57`) on one 4-vCPU VM; means with the range of the three runs:

| Case                                   | Before p50 / p95 / p99 (ms) | After p50 / p95 / p99 (ms) | Throughput (op/s)                               | CPU/op (ms) |
| -------------------------------------- | --------------------------- | -------------------------- | ----------------------------------------------- | ----------- |
| PGlite `query-latency/sequential`      | 0.593 / 0.751 / 0.873       | 0.519 / 0.685 / 0.803      | 1,604 (1,539–1,653) → 1,838 (1,793–1,868)       | 1.05 → 0.94 |
| PGlite `query-latency/concurrent-64`   | 38.5 / 43.7 / 46.7          | 34.0 / 38.8 / 42.2         | 1,615 (1,606–1,622) → 1,834 (1,808–1,859)       | 0.69 → 0.61 |
| PGlite `receipt-replay/sequential`     | 0.740 / 0.836 / 1.055       | 0.765 / 0.841 / 0.996      | 1,319 → 1,292 (1,212–1,333)                     | 0.78 → 0.80 |
| Postgres `query-latency/sequential`    | 0.116 / 0.734 / 1.018       | 0.123 / 0.661 / 0.966      | 3,845 (3,379–4,657) → 4,954 (4,210–5,943)       | 0.30 → 0.29 |
| Postgres `query-latency/concurrent-64` | 0.654 / 1.396 / 3.072       | 0.669 / 1.431 / 3.188      | 11,304 (10,863–12,170) → 11,003 (10,828–11,184) | 0.10 → 0.11 |
| Postgres `receipt-replay/sequential`   | 0.399 / 1.012 / 1.432       | 0.364 / 0.967 / 1.533      | 1,977 (1,700–2,304) → 2,098 (1,926–2,348)       | 0.22 → 0.21 |

On PGlite every after run beat every before run in both query cases: p50 −12%, throughput +14–15%, CPU per query −10–12%. Receipt replay does not run the query statement and stayed within noise. On Postgres the change is within noise in every case; one-caller throughput there swings by up to 75% between runs of the same code. Statements per operation stayed at 1 for queries and 2 for receipt replay. PGlite queries remain about 0.13 ms slower than before the events merge: the second index lookup is the price of a state read and event cursor from one snapshot. Only caching the plan (a prepared statement) would remove the remaining planning cost.

### Multi-runner relay (M2.4, #96)

`2026-09-27-0ba95fc-relay-{postgres,pglite}.json` and the same-SHA repeat `2026-09-27-0ba95fc-relay-repeat-{postgres,pglite}.json` run `bun run bench --scenario outbox,effect-round-trip --runners 1,2,4` (full profile) on `main` `0ba95fc`, which includes the probe widening past locked rows and the backoff cap fix. `2026-09-27-cd74d7e-relay-{postgres,pglite}.json` is the same command on the branch before those fixes. All runs used Postgres 18.6 in Docker, PGlite 0.5.8, Bun 1.4.2, and one 8-vCPU Xeon 8559C machine shared by the client, the runners, and Postgres. The runners are in-process and share those CPUs, so the runner counts measure claim contention, not scale. No run had errors.

| Postgres case                   | Runners | `cd74d7e` p50/p95/p99 ms | `0ba95fc` p50/p95/p99 ms | Repeat p50/p95/p99 ms    | Statements/op (`0ba95fc`) |
| ------------------------------- | ------- | ------------------------ | ------------------------ | ------------------------ | ------------------------- |
| outbox/delivery-sequential      | 1       | 5.19 / 8.42 / 11.15      | 5.20 / 8.89 / 12.34      | 5.39 / 8.74 / 11.69      | 14.13                     |
| outbox/delivery-sequential      | 4       | 4.50 / 6.12 / 8.12       | 5.36 / 6.87 / 7.91       | 5.41 / 7.00 / 8.19       | 14.17                     |
| outbox/delivery-concurrent-16   | 1       | 19.59 / 31.83 / 39.98    | 22.39 / 34.32 / 41.62    | 22.08 / 35.00 / 41.86    | 13.30                     |
| outbox/delivery-concurrent-16   | 4       | 24.62 / 31.94 / 39.76    | 23.42 / 30.52 / 36.63    | 23.25 / 29.74 / 35.83    | 13.88                     |
| outbox/drain-20000              | 1       | 34.58 / 57.27 / 109.46   | 34.05 / 40.65 / 46.04    | 33.93 / 40.59 / 46.02    | 5.20                      |
| outbox/drain-20000              | 4       | 43.35 / 63.17 / 87.48    | 39.53 / 51.86 / 63.84    | 40.12 / 52.46 / 65.11    | 5.28                      |
| effect-round-trip/sequential    | 1       | 7.07 / 9.52 / 12.61      | 8.66 / 10.48 / 12.02     | 8.19 / 10.10 / 11.45     | 18.00                     |
| effect-round-trip/sequential    | 4       | 7.24 / 9.50 / 11.60      | 8.51 / 10.50 / 12.01     | 8.40 / 10.50 / 12.11     | 18.03                     |
| effect-round-trip/concurrent-64 | 1       | 94.98 / 119.73 / 141.96  | 99.03 / 131.29 / 144.65  | 102.46 / 139.54 / 156.95 | 16.22                     |
| effect-round-trip/concurrent-64 | 4       | 71.93 / 350.36 / 592.66  | 97.81 / 243.28 / 340.79  | 73.81 / 306.72 / 615.87  | 16.80                     |

- **The fixes add no statements.** Statements per operation match `cd74d7e` in every case to within 0.07, and more runners add at most 0.7 per operation, from claims that find their candidates taken by another runner. The locked-row widening only widens the next claim's probe, and it only applies after a claim leaves capacity free, so the drain cases, which keep every slot busy, didn't change.
- **Adding runners doesn't speed anything up on one machine.** With 4 runners, a 20,000-intent drain ran at 1,556–1,564 intents/s against 1,746–1,838 with one runner. Sequential latency stays near 5 ms for outbox delivery and 8.5 ms for an effect round trip at every runner count. More runners on one machine split the same CPUs and contend on the same rows.
- **The effect tail with 64 callers is noise.** At 4 runners, the `concurrent-64` p99 was 593, 341, and 616 ms across the three runs, while its p50 stayed between 72 and 98 ms. The two `0ba95fc` runs disagree as much as either one differs from `cd74d7e`, so this is run-to-run variance in executor-lease contention, not a change from the fixes.
- **Some single-runner p50s are 0.5–1.6 ms higher than at `cd74d7e`.** The largest is `effect-round-trip/sequential`, at 7.07 ms before and 8.19–8.66 ms after. The same-SHA repeat reproduces it, but the statement counts and the SQL on this path are unchanged. It could be machine drift between runs hours apart; it wasn't isolated further.
- **PGlite is unchanged within noise.** It runs one runner only: `outbox/delivery-sequential` p50 was 8.82 ms before and 8.96–9.15 ms after, and `effect-round-trip/concurrent-64` 491 ms before and 465–474 ms after.

### Turn batches (P5, #160)

`2026-09-28-30b34c8-p5-turn-batches-postgres.json` is one `ci` profile run on Postgres 18.6 (Bun 1.4.2, one 4-vCPU cloud VM, Postgres in Docker on loopback); three further `hot-actor` and `turn-batches` runs on the same VM matched it within 0.02 statements and 0.01 round trips per operation.

- **`turn-batches/waiting-32`:** each operation is one held turn plus 32 commands waiting behind it. It costs 107.03 statements and 4 round trips: the held turn's 2 and the batch's 2. The same 33 commands unbatched cost 33 × 7 = 231 statements and 66 round trips. Per command, the turn itself now costs 4 statements for all 32 (settings, fence, one state upsert, one multi-row receipt insert); the rest are the 3 per-command reads outside the turn (command id minting, the pre-delivery receipt read, and the expiry recheck).
- **`hot-actor` under contention now batches.** `concurrent-8` fell from 7 to 4 statements and from 2 to 0.5 round trips per command: the first caller's turn runs alone and the other seven wait behind it, so batches alternate 1 and 7. `concurrent-64` fell from 7 to 3.2 statements and from 2 to 0.1 round trips, about 20 commands per batch. Throughput rose from 351–375/second (the M1 measurement) to 612–686/second with 8 callers and 911–1,275/second with 64 across the four runs; `concurrent-64` p50 fell from 82–103 ms after P4 to 47–60 ms. The planning envelope's 2,000–10,000/second with batches is not reached on this VM, where the benchmark client, the runtime, and Postgres share four cores.
- **Unchanged:** a lone command still takes 7 statements and 2 round trips (`hot-actor/sequential`), and every other gated case is within the gate's tolerance.

### Pipelined batches (P5 part 2, #160)

`2026-09-28-1c86f1c-p5-pipelined-batches-postgres.json` is one `ci` profile run on the same VM; three more `hot-actor` and `turn-batches` runs matched it within 0.12 statements and 0.01 round trips per operation.

- **`turn-batches/waiting-32`:** 3 round trips per operation instead of 4, since the batch's admission rides in the held turn's commit flight; statements are unchanged at 107.03.
- **`hot-actor` under contention:** `concurrent-8` went from 4 to 4.32–4.44 statements and from 0.5 to 0.36–0.37 round trips per command; `concurrent-64` from 3.2 to 3.28–3.30 statements and from 0.1 to 0.07 round trips. The next batch is now taken while the previous one commits, before that batch's callers have sent their next commands, so batches are a little smaller (more fence and receipt statements per command) but each rides a commit flight (fewer round trips). Throughput and latency moved within run-to-run noise (`concurrent-8` 540–720/second, `concurrent-64` 1,101–1,148/second).

### Commutative merging (P6, #161)

`2026-09-28-b75859f-p6-merging-postgres.json` is one `ci` profile run on the same VM. `2026-09-28-ef1a2f8-p6-merging-per-call-postgres.json` reruns `turn-batches` after the merged case moved to per-call counts; two more runs matched it within 0.0002 statements per call.

- **`turn-batches/merged-1024`:** each round holds one turn open, queues 1,024 calls of a commutative reducer behind it, and releases it. A round costs about 3,084 statements and 3 round trips: the held turn's commit carries the merged batch's admission, then one commit writes one state row and 1,024 receipts. The case reports them per call (3.0086 statements and 0.0029 round trips), because a round lasts most of a second and background work such as relay polls lands in it a varying number of times: per round, two runs of one commit differed by 0.5 statements, past the gate's tolerance. Almost all of the statements are the 3 per call outside the turn (command id minting, the pre-delivery receipt read, and the expiry recheck); the merged turn itself is about 9. Unmerged, the same 1,025 calls cost about 7,175 statements and 2,050 round trips. A round takes about 0.8 s p50 on this VM, dominated by the 1,024 calls' client-side work (1.1 s of client CPU per round).
- Every other case is within the gate's tolerance.

### Orders example (CR.8, #95)

`2026-09-28-ed00421-cr.8-orders-{postgres,pglite}.json` runs `bun run bench --scenario orders --label cr.8-orders` (full profile, one run per backend) with Bun 1.4.2 and Postgres 18.6 on one 16-vCPU Xeon VM shared by the client, the runtime, and Postgres. The scenario calls `examples/orders`' own `Order.Place` with two lines in two packages against an in-process fake provider, on a fresh order id each time. Each order is six turns on three new actors: `Place`, two shipment `Open`s, `Charged`, and two `Release`s, plus one executor call. The relay's work overlaps the next order in every case, so statements per operation count the whole order, not one turn.

| Postgres case         | op/s  | p50 / p95 / p99 ms   | stmts/op | client CPU/op ms |
| --------------------- | ----- | -------------------- | -------- | ---------------- |
| `place`               | 58.8  | 15.8 / 26.6 / 36.3   | 79.9     | 26.2             |
| `place-to-paid`       | 41.5  | 21.5 / 38.7 / 52.1   | 80.0     | 25.8             |
| `place-concurrent-16` | 214.8 | 60.5 / 176.9 / 240.4 | 23.8     | 6.1              |

- **The effect round trip adds about 6 ms at p50.** `place-to-paid` waits for the executor and the `Charged` turn, which the relay runs after `Place` commits; 21.5 ms against 15.8 ms for the acknowledged `Place`.
- **An order is about 80 statements on six turns.** Every order activates three actors it has never seen, so each turn pays a cold activation (generation insert, state read) on top of its receipt and state writes. `place-concurrent-16` counts 23.8 statements per order, most likely because the relay falls behind 16 callers and much of the orders' shipment and charge work is still queued when the window closes; this run did not confirm that.
- **PGlite's single connection sets its pace:** 18.3 op/s for `place` (p50 51.6 ms), 15.6 for `place-to-paid`, and 45.5 with 16 callers.

The crash drill (`examples/orders/src/drill/runner.test.ts`) measured, per fault point, the time from the SIGKILL until the order was paid on the replacement runner: under 1 s when nothing was claimed (`beforeHandler:Place`, `beforeCommit:Place`, and both `beforeOutboxDelete` points), and about 3.1 s when the killed runner held a claim (`afterCommit:Place`, `afterClaim`, and both executor points), bounded by the drill's 3-second relay and executor leases. Every run applied one charge per order; at `afterExecute:Charge` the provider saw two calls for the key.

### Cron (M2.5, #132)

`2026-09-28-094b4a3-m2.5-cron-runners-{1,2,4}-postgres.json` run `bun run bench --backend postgres --scenario cron --runners <n>` (full profile), once per runner count, on branch `feat/51-cron` at `094b4a3` (clean tree, merged with `main` at `910e60d`). Postgres 18.6 ran as a local server with `pg_stat_statements` preloaded and default durability (`fsync`, `synchronous_commit`, and `full_page_writes` on), through `BENCH_DATABASE_URL`, so server CPU isn't recorded. Bun 1.4.2 and Effect 4.0.0-rc.116 ran on one Amp orb (E2B cloud VM, 16 vCPUs of an Intel Xeon at 2.60 GHz, 31 GiB), shared by the client, the in-process runners, and Postgres. Each run has 3 rounds. Each round creates 10^5 `CronProbe` actors on a fresh database, each declaring `* * * * *`, moves every tick to one minute boundary, and waits until every actor's tick has run. Creation takes 4–7 minutes, so every actor has hibernated by the boundary, and each tick is a wake turn in a new generation.

| Runners | Ticks  | Errors / duplicate ids | Drain, 3 rounds | Ticks/s | Lateness p50 / p99 / max | Round p99s      | Statements/tick | Claim mean (calls, last round) |
| ------- | ------ | ---------------------- | --------------- | ------- | ------------------------ | --------------- | --------------- | ------------------------------ |
| 1       | 3×10^5 | 0 / 0                  | 1,125 s         | 267     | 133 s / 297 s / 392 s    | 289, 305, 294 s | 13.35           | 1.106 ms (42,624)              |
| 2       | 3×10^5 | 0 / 0                  | 1,234 s         | 243     | 149 s / 350 s / 433 s    | 318, 353, 352 s | 12.86           | 1.175 ms (41,360)              |
| 4       | 3×10^5 | 0 / 0                  | 1,789 s         | 168     | 157 s / 376 s / 658 s    | 331, 386, 350 s | 16.83           | 1.187 ms (53,944)              |

- **Every tick fires once.** Each round ran each of its 10^5 actors' ticks, and no handler run repeated a command id at any runner count.
- **Lateness is drain time.** All 10^5 ticks fall due at one instant, and the runtime runs them as fast as one process can wake actors: about 267 wake turns per second with one runner, with the benchmark process at 113% CPU. The median tick is late by about half the drain. So on this VM, 10^5 actors on a minutely schedule can't keep up in one process: a boundary takes over 6 minutes to drain, and actors that fired early fire again at the next boundaries meanwhile (the scenario counts each actor's first run only).
- **More in-process runners are slower here.** 2 and 4 runners share the same process and CPU, and they contend for the same due rows, so throughput falls to 243 and 168 ticks/s, and statements per tick rise at 4 runners from claims that find their candidates taken. This matches the [multi-runner relay](#multi-runner-relay-m24-96) result and says nothing about separate machines.
- **The relay claim stays about 1.1–1.2 ms** at each runner count while 10^5 ticks are due. It takes about three ticks per claim.
- **A woken actor's tick write is one statement.** Its first turn re-inserts its pending tick, and the unique index rejects it: 121,158 calls for about 122,000 deliveries in the one-runner round, at 0.066 ms.
- **The claim mean is read from `statements`.** At `094b4a3`, the scenario's `relayClaimMeanMs` is -1 because it searched for `SKIP LOCKED`, which falls past the 160 characters of query text the harness stores. The claim mean above is read from the listed `WITH intent_candidates …` statement, and the scenario now matches that prefix.

### Row-level security (M4.5, #232, #256)

`2026-09-29-630e421-m4.5-rls-view-owner-postgres.json` runs `bun run bench --backend postgres --scenario rls` (full profile) on branch `feat/256-rls-follow-ups` at `630e421` (clean tree). Postgres 18.6 ran in the harness's container with `pg_stat_statements` and default durability. Bun 1.3.14 and Effect 4.0.0-rc.116 ran on a 4-vCPU cloud VM (15 GiB) shared by the client, the runtime, and Postgres. Each case is one warm actor with 1,000 owned rows and one caller, first with the runtime as the exempt table owner, then with `rowLevelSecurity` on ([ADR 0051](../decisions/0051-row-level-security.md)). The scenario's role script now hands the views to a separate view-owner role, as the startup check requires; before that change the scenario refused to start with RLS on.

| Case                  | Off: p50 / p99 ms | On: p50 / p99 ms | Statements off → on | Round trips off → on |
| --------------------- | ----------------- | ---------------- | ------------------- | -------------------- |
| Command turn          | 6.01 / 15.12      | 5.80 / 14.59     | 7 → 7               | 2 → 2                |
| State query           | 0.32 / 5.90       | 0.62 / 3.75      | 1 → 2               | 0 → 0                |
| Owned-row insert turn | 9.13 / 15.83      | 5.30 / 13.79     | 7 → 7               | 3 → 3                |
| Owned-row point query | 0.77 / 7.46       | 0.91 / 3.99      | 2 → 3               | 0 → 0                |

- **Turns pay no statement or round trip.** The role and tenant settings ride on the `set_config` statement a turn already opens with. The turn latencies are noise on this VM: a first run of the same scenario measured the turn at 5.54 ms off and 6.44 ms on, and the insert turn at 9.17 ms off and 6.70 ms on.
- **Queries pay their transaction.** With RLS on, a query runs as `BEGIN`, one `set_config` statement, its reads, and `COMMIT`. That adds about 0.3 ms at p50 here. `pg_stat_statements` counts transaction control once per distinct text, so the statement column shows only the `set_config` statement.
- **The policy predicate costs nothing measurable here.** Each scoped statement already filters on `tenant_id`.
- **Feed pages and workflow polls** open the same tenant transaction with RLS on and are unchanged with it off. The scenario doesn't time them; the conformance case proves they run as the tenant role.

### Content blobs (M4.13, #222)

The `content-blobs` scenario ([`6b35562-m4.13-content-blobs`](../../benchmarks/results/2026-09-29-6b35562-m4.13-content-blobs-postgres.json), full profile, Postgres 18.6 with `pg_stat_statements`, one orb VM shared with the runtime) measures the built feature. Latency is from one run; statements per operation are the stable number.

| Case                                              | Rate      | p50 / p99 ms | Stmts/op |
| ------------------------------------------------- | --------- | ------------ | -------- |
| dedup-skewed (2,000 uploads of 64 KiB, 200 items) | 1,766/s   | 4.1 / 13.7   | 1.11     |
| upload-4k                                         | 840/s     | 1.1 / 2.3    | 2        |
| upload-1024k                                      | 81.7/s    | 11.8 / 23.5  | 2.03     |
| upload-8192k                                      | 12.5/s    | 78.2 / 97.4  | 9.06     |
| attach (warm turn)                                | 275.9/s   | 3.5 / 8.6    | 7.01     |
| read-4k (`get` in a query)                        | 1,736.8/s | 0.53 / 1.06  | 3        |
| read-1024k                                        | 279.8/s   | 2.8 / 16.6   | 3        |
| sweep-1000 (1,000 candidates, half referenced)    | one sweep | 17.8         | 11       |

- **Deduplication.** The skewed set uploaded 131,072,000 bytes and stored 13,107,200: a ratio of 10, one copy per distinct item. A duplicate upload costs the upsert alone (1.11 statements per upload on average), so repeated uploads of popular content are cheaper than new ones.
- **Upload cost** is one upsert plus one statement per 1 MiB chunk (8 MiB: 9 statements), in one transaction on the tenant's shard.
- **Attach** is a warm turn whose content statement replaces a state write: 7.01 statements, the same as `hot-actor`.
- **Reads** are the reference on the actor's shard and one statement for every chunk on the tenant's, plus the query's own statement.
- **Sweep:** 1,000 candidates, half of them referenced, took 18 ms and 11 statements: the tenant list, the turn bound, and per batch of 500 a candidate read, a reference scan, and one delete of content and chunks.

### Failure drills (T7)

`TEST_DATABASE_URL=<url> bun --bun node_modules/vitest/vitest.mjs run packages/durable-actors/src/testing/conformance/crash/drills/runner.test.ts --disableConsoleIntercept`, repeated 10 times on branch `fix/219-drill-start-gate` (`main` at `aa8af52` plus the fix); each run prints one `DRILL` line. Postgres 18.6 installed in an Amp orb, Bun 1.4.2, one machine shared by the five runner processes and Postgres. Workload: three processes that start their operations together once all three are ready (the first holds at its 60th until the kill), then two replacements, each running sequential `Increment` + `Send` operations (the `Send` relays an `Add`); runner 1 is killed after 30 operations and runner 2 while its relay holds a claim. Shard locks expire after 3 s, relay claims after 5 s. This is a correctness drill on a shared VM, not a scale measurement.

| Metric                                         | Min    | p50    | Max (≈p95 of 10) |
| ---------------------------------------------- | ------ | ------ | ---------------- |
| Recovery, kill to the stalled command's commit | 2.50 s | 3.27 s | 4.57 s           |
| Slowest single operation on a survivor         | 2.50 s | 2.72 s | 3.66 s           |
| Committed operations per run                   | 305    | 314    | 319              |
| Lost / duplicated operations                   | 0 / 0  | 0 / 0  | 0 / 0            |

Recovery runs from the kill to the commit of the slowest command the first runner, which stays up and serving throughout, started after it on one of the killed runner's shards. Each runner reports the shards its commands went to, and the drill reads the killed runner's shards from `cluster_locks` just before the kill and asserts at least one such command, so the measured command provably waited on a dead runner's shard and its commit marks that shard serving again. It is bounded by the 3 s shard-lock expiry plus Cluster's shard refresh, and can be under 3 s because the dead runner's last lock refresh predates the kill. Until [#219](https://github.com/Rika-Labs/durable-actors/issues/219) the first runner started its operations before the other two were up and could finish them all before the kill, which left no post-kill command on it to measure and the kill not under load. With 10 samples, p99 is not meaningful. Committed operations vary because a runner killed mid-operation may commit an `Increment` without its `Send`; those are counted as committed, never lost.

### Embedded PGlite (M4.14)

`2026-09-29-378a83d-m4.14-embedded-pglite-file.json` runs `bun run bench --profile full --backend pglite-file --scenario embedded-pglite --label m4.14-embedded` on `378a83d`: PGlite 0.5.8 (Postgres 18.3), Bun 1.4.2, on an Amp orb (an E2B cloud sandbox VM, 16 logical CPUs of an Intel Xeon at 2.60 GHz, 31.4 GiB, Linux 6.1). Each case's `dataDir` is a fresh directory under `/tmp` on ext4. One run; nothing else ran during it.

| Stored actors | Database size | Warm turn p50 / p99 (ms) | Wake p50 / p99 (ms) | 16 callers (op/s) |
| ------------- | ------------- | ------------------------ | ------------------- | ----------------- |
| 0             | 9.6 MB        | 4.53 / 13.2              | 6.06 / 16.0         | 219               |
| 10,000        | 17.1 MB       | 4.50 / 11.1              | 5.84 / 13.6         | 213               |
| 100,000       | 82.4 MB       | 4.49 / 10.8              | 5.76 / 10.0         | 213               |

- A turn takes about 4.5 ms and costs about 5 ms of CPU, whatever the stored size up to 100,000 actors. On one connection turns run one after another, so 16 callers get the same ~213 turns per second as one, and each waits about 16 turns (p50 74 ms).
- A wake after hibernation adds about 1.5 ms for the generation fence and the state read. Every measured wake took a new generation (`reactivatedFraction` 1).
- The largest measured database is 82 MB (100,000 seeded actors, each with a 256-byte state value and one receipt). ADR 0035 claims nothing larger.
- These numbers include the WAL writes a file-backed `dataDir` makes on every commit. They do not measure power-loss durability, which is not claimed.

### Failure drill II: Postgres primary failover (T10)

`bun --bun node_modules/vitest/vitest.mjs run packages/durable-actors/src/testing/conformance/crash/drills/failover.test.ts --disableConsoleIntercept`, repeated 10 times on branch `test/223-failover-drill` (`main` at `7fef2da` plus [#244](https://github.com/Rika-Labs/durable-actors/pull/244) and this drill); each run prints one `FAILOVER` line. Machine: one Amp orb (E2B cloud VM, 16 vCPUs of an Intel Xeon at 2.60 GHz, 31 GiB), running Bun 1.4.2, the three runner processes, and Docker 29.8.1.

**Setup.** The drill starts its own Postgres 18.6 primary and a streaming standby as `postgres:18.6` containers on the host network. The standby is taken with `pg_basebackup -R`. Once it streams, the primary is switched to synchronous replication: `synchronous_standby_names = '*'` with `synchronous_commit` on. Runners reach the database only through a TCP endpoint in the test process, which stands in for the DNS name or virtual IP a hosted failover moves.

**Workload.** Three runner processes ([`runner.ts`](../../packages/durable-actors/src/testing/conformance/crash/drills/runner.ts), the T7 runner) start together. Each runs 120 sequential operations of an `Increment` plus a `Send` whose `Add` crosses the relay, each command under a minted id retried until it commits. Shard locks expire after 3 s and relay claims after 5 s.

**The failure.** Once every runner has done 30 operations, the endpoint holds the database's replies, as a partition would, until the primary shows a committed `Increment` or `Send` receipt that no caller has heard of. Then:

1. The primary container gets SIGKILL, which takes every backend and the WAL sender with it.
2. The endpoint drops every connection.
3. `pg_promote()` runs on the standby, and the endpoint moves to it.

Failure detection, which a failover manager adds before promoting, is not in these numbers.

Two sets of 10 runs. The first, before the fix, ran on `main` at `7fef2da` with [#244](https://github.com/Rika-Labs/durable-actors/pull/244), on the machine above. The second ran on branch `fix/243-retryable-turn-unavailable` (`main` at `d7b76a3` plus the fix for [#243](https://github.com/Rika-Labs/durable-actors/issues/243)) on a different machine: a cloud VM with 4 vCPUs of an AMD EPYC and 15 GiB, Docker 29.8.1, and Bun 1.4.2 as CI runs, with no resource limits beyond that. The two sets are not the same hardware.

| Metric                                                      | Before #243's fix: min / p50 / max | After: min / p50 / max |
| ----------------------------------------------------------- | ---------------------------------- | ---------------------- |
| Commit-unknown commands per run (resolved through receipts) | 1 / 2 / 3                          | 1 / 2 / 3              |
| Promotion: kill to `pg_promote()` returning                 | 0.20 / 0.25 / 0.31 s               | 0.21 / 0.22 / 0.25 s   |
| Recovery: kill to every runner committing again             | 0.37 / 30.10 / 30.13 s             | 0.36 / 0.47 / 0.90 s   |
| Slowest single operation                                    | 1.05 / 30.12 / 30.14 s             | 0.98 / 1.06 / 1.11 s   |
| Committed operations per run                                | 360 / 360 / 360                    | 360 / 360 / 360        |
| Lost / duplicated operations                                | 0 / 0 in every run                 | 0 / 0 in every run     |

- **No lost or duplicated work.** Every run of both sets committed all 360 operations once. Every command a runner heard acknowledged, and every receipt the old primary showed while replies were held, is on the promoted primary. The counter and receiver totals equal their receipt counts.
- **Commit-unknown resolves through receipts.** 18 commands before the fix and 17 after had committed on the primary with their replies still in flight when it died. Each caller's retry under the same id was answered from the receipt the standby had received, without a second transition.
- **Before the fix, recovery was bimodal: about 0.4 s, or the whole 30 s `deliveryTimeout`.** 2 runs recovered in 0.37 s and 0.42 s. In the other 8, one command caught by the failover waited out its caller's `deliveryTimeout` (30 s by default), and its retry then committed at once.
  - The cause was in Effect Cluster ([#243](https://github.com/Rika-Labs/durable-actors/issues/243)). A turn that failed with a retryable SQL error died, so Cluster restarted its entity and re-sent the command to the rebuilt handler. When the re-sent turn failed again before the rebuild completed, which a refused connection does within a millisecond, Cluster ignored the second defect: the command was never run again or answered.
- **After the fix, every run recovers in about a second or less: 0.36–0.90 s in the ten runs above, and no operation takes longer than 1.11 s.** Five more runs after the last merge with `main` and a guard that refuses commands while a restart is incomplete recovered in 0.38–1.11 s (1.11, 0.96, 0.38, 0.39, 0.84 s), with 0 lost and 0 duplicated, so the ten-run maximum is not a bound. A retryable turn failure now restarts the activation in place and answers its caller `ActorUnavailable`, instead of dying so Cluster restarts the entity and re-sends the command; the caller retries under the same id, and the receipt keeps the retry exactly-once. Recovery is the promotion, the activation's backoff (50 ms, doubling per failure), and the caller's retry delay (250 ms ±50%, then 500 ms).

- **A mint during the outage used to kill its caller.** Before [#244](https://github.com/Rika-Labs/durable-actors/pull/244), a command-id mint that reached the database while it was unreachable died instead of failing `ActorUnavailable`. That took down a whole runner process that minted 16 ms before the kill. The drill's runner retries its mint like any command.

Not covered:

- failure detection time;
- a standby on another host or zone, where synchronous commit costs a network round trip per turn;
- asynchronous replication, which [deployment](../operations/01-deployment.md#postgres-primary-failover) rules out;
- shard ownership by session advisory locks (the drill runs `shardLockDisableAdvisory: true`, as T7 does);
- the promoted primary's own replacement standby;
- more than one failover per run.

With 10 samples, p99 is not meaningful.

### M4 exit rehearsal: drain, failover, and restore on the served chat room (#306)

`CHAT_BACKEND=postgres bun --bun node_modules/vitest/vitest.mjs run --root . examples/chat/src/rehearsal`, on Dallen's MacBook Pro (Apple silicon, Docker Desktop) with load averages of 20–60 from other worktrees. Each run prints one `REHEARSAL` line. The drill is [`examples/chat/src/rehearsal/deployment.test.ts`](../../examples/chat/src/rehearsal/deployment.test.ts), and it runs in the chat package's `test:integration` script.

**Setup.** The T10 pair: a Postgres 18.6 primary with a synchronous standby in Docker, behind the drill's TCP endpoint. The chat room (`RoomLive`, with its moderation effect, feed, blobs and idle timer) runs on three `ActorTest.cluster` runners. Each runner has its own HTTP listener serving `Actor.serve({ actors: [Room] })` over that runner's runtime, as three processes behind a load balancer would. Six clients post to twelve rooms. Each post takes an id from `/command-ids`, goes only to a listener whose `/ready` answers 200, and is retried under the same idempotency key until it is acknowledged.

**One run, in order:**

1. **Deploy.** All three `/ready` answer 200, and the clients post.
2. **Drain a runner under load.** `RuntimeControl.drain({ deadline: "20 seconds" })` on runner 0. Its `/ready` answers 503 `draining`/`drained`. Its listener is removed, it shuts down gracefully, and the others keep serving. It then restarts and rejoins.
3. **Fail over the Postgres primary.** Replies are held until the primary shows a committed `Post` no client has heard of. Then SIGKILL, `pg_promote()` on the standby, and the endpoint moves to it. The clients keep posting until 60 more are acknowledged, then stop. Every acknowledged id and every receipt the old primary showed is on the promoted primary, and receipts, `chat_messages` rows and `MessagePosted` events each number exactly the posts sent, with no event twice.
4. **Back up, keep serving, restore.** The runners stop, and the database is copied whole (the stopped-copy backup of [backup and restore](../operations/04-backup-restore.md)). A new deployment serves about 50 more posts, then stops. A deployment on the backup holds exactly phase one. Every client then retries every post of both phases under its original key: all answer 200. The phase-two posts, which the backup lost, run once each, and the phase-one posts replay without a handler run. Receipts, rows and events equal all posts, with no event twice. After the framework clock moves past the 24-hour retry window, every retry is refused with `CommandExpired`.

| Run | Phase-one posts | Drain outcome, time, interrupted | In flight at drain | Commit-unknown | Kill to `pg_promote()` | Kill to first ack after | Slowest post | Posts lost after restore (re-run on retry) | Lost / repeated |
| --- | --------------: | -------------------------------- | -----------------: | -------------: | ---------------------: | ----------------------: | -----------: | -----------------------------------------: | --------------- |
| 1   |             510 | clean, 45.5 s, 0 / 0             |                  1 |              1 |                 1.31 s |                  1.97 s |      11.04 s |                                         47 | 0 / 0           |
| 2   |           2,669 | clean, 101.4 s, 0 / 0            |                  4 |              2 |                 0.21 s |                  0.32 s |       3.68 s |                                         47 | 0 / 0           |
| 3   |           1,107 | clean, 9.9 s, 0 / 0              |                  2 |              1 |                 0.21 s |                  0.31 s |       1.57 s |                                         48 | 0 / 0           |

- **No command ran twice or got lost** in any run: through the drain, the failover and the restore, each acknowledged post has one receipt, one row and one `MessagePosted` event, and the restored deployment converges to one of each after client retries.
- **Commit-unknown posts resolve through receipts.** Every post that committed on the primary while its reply was held was later acknowledged to its client under the same id.
- **External calls.** The moderation effect of a phase-one post reached the stand-in provider more than once in 4–7 posts per run (runs 2 and 3; run 1 did not check), always under one idempotency key: effect retries after the failover, which a provider honouring the key answers once. A phase-two post the restore lost is moderated again under a new effect id when its client retries, which is the reconciliation case step 5 of [backup and restore](../operations/04-backup-restore.md#restore-procedure) describes.
- **Drain time exceeded its deadline while reporting clean.** The drain call took 9.9–101.4 s against a 20 s deadline, with nothing interrupted. The machine was heavily loaded and the time includes the harness's dispatch to runner 0, so this is not yet a drain defect; [#423](https://github.com/Rika-Labs/durable-actors/issues/423) tracks it. The clients saw no failures during it: other runners served every post.
- These are single-machine numbers under unrelated load, not targets. The failover recovery times agree with T10's (0.31–1.97 s here, 0.36–1.11 s there).

### SSE event feeds (M3.3, #293)

The `sse` scenario ([`4822780-m3.3-sse`](../../benchmarks/results/2026-09-29-4822780-m3.3-sse-postgres.json), full profile, one run) serves an actor's `Pinged` events as an SSE feed through `Actor.serve` on a `Bun.serve` listener over loopback HTTP/1.1, and reads them with the Promise client's `handle.events`. It ran on an Apple M5 Max (18 cores, 128 GiB) with Bun 1.4.2, with the benchmark client, the runtime, and the HTTP server in one process and Postgres 18.6 at `BENCH_DATABASE_URL` on the same Mac. That Mac was shared with other work, so treat the tails as noisy.

| Case                                             | Rate   | p50 / p95 / p99 ms    | Stmts/op |
| ------------------------------------------------ | ------ | --------------------- | -------- |
| feed-live-1 (command to its event on one feed)   | 42.7/s | 11.4 / 90.1 / 180.8   | 7.07     |
| feed-live-64 (command to its event on 64 feeds)  | 57.0/s | 13.1 / 40.6 / 93.6    | 7.02     |
| feed-replay-5000 (a new feed reads 5,000 events) | 8.1/s  | 124.2 / 147.9 / 165.9 | 45.15    |

- **Live delivery** is timed from a command's call until every open feed holds its event. With 64 open feeds on the actor, p50 rose from 11.4 to 13.1 ms, and the command's cost stayed at 7 statements: the owner broadcasts a committed feed event to the feed rows without more database work per feed. The one-feed p95 (90 ms) is above the 64-feed p95 (41 ms) in this run, which was not repeated, so the tails say little about feed count.
- **Replay** reads committed events from `actor_events` in pages of 256 without waking the actor: 5,000 events took a median of 124 ms (about 40,000 events per second) and 45 statements per replay, about 20 pages plus the request's own statements.
- No case had errors. This covers loopback HTTP/1.1 only: it does not measure TLS, HTTP/2, or a feed that lags behind the owner's live buffer.

### M2 close: statements per operation against the baseline

The M2 exit criterion "statements per operation match T2's baseline" was checked on 2026-09-30 against the `Statements` workflow's artifacts from 20 runs on 2026-09-29 (pull requests and pushes to `main`, each a `ci` profile run on Postgres 18.6 on a 4-vCPU CI runner), and against the latest run on `main`, which passed. The baseline is `benchmarks/baselines/statements.json` at `29d7397`; the gate fails a case that moves by more than its tolerance in either direction.

- **Concurrent cases are noisy, and now have a tolerance.** Across 23 `Statements` runs of one code version, `hot-actor/concurrent-8` fell into two groups, 4.27 to 4.29 and 4.69 to 4.88, up to 11% under its baseline of 4.79, depending on how many concurrent commands share a batch. The others stayed close together: `outbox/delivery-concurrent-16` 14.48 to 14.67 (baseline 14.58), `effect-round-trip/concurrent-64` 17.29 to 17.50 (17.35), `hot-actor/concurrent-64` 3.24 to 3.47 (3.37). Comment-only pull requests still failed at 14.82 and 17.56, beyond that range, so the spread over a day is wider than any one sample. The gate now compares cases with `concurrent` in their name within 5% of the baseline, and `hot-actor/concurrent-8` within 12%, never tighter than 0.2 (`toleranceOf` in `tooling/benchmarks/src/compare.ts`). Deterministic cases stay at 0.2. The cost: a concurrent case's regression under its tolerance passes, for example one statement per operation in `outbox/delivery-concurrent-16` (7%) fails but 0.5 does not. The sequential cases and `turn-batches` still catch changes to the turn's own statements.
- **Every other case** matched its baseline within 0.2 in the latest run on `main`.

### Recommendations (not applied)

These are runtime changes, so each belongs in its own pull request:

- Compute the payload hash and the database time once per command, instead of twice and three times. That removes three to four round trips from every command (#40, done: 14 to 10 round trips per warm turn).
- Report Cluster's never-cleared processed-request set under `MessageStorage.layerNoop` upstream (#46 bounds it in the runtime; the upstream report still needs a go-ahead).
- Rerun `many-actors` after #41 and measure heap per resident activation before making any claim above 10k actors per runner (#59, done: about 19.5 KiB per resident activation; the default stays 10,000).
- Add a measured stored-actor overhead case, using relation sizes after N actors, and several-runner cases before testing the per-shard turn hypothesis.
