# Benchmarks

This directory holds committed benchmark results. The harness that produces them is `tooling/benchmarks/` ([ADR 0018](../docs/decisions/0018-benchmark-harness-and-results.md)). [Performance](../docs/verification/03-performance.md) compares these numbers with the planning hypotheses.

Every number here comes from one machine. It says how this runtime behaves on that machine and nothing about production capacity.

## Run

```sh
bun install
bun run bench                                   # every scenario, Postgres 18 then PGlite
bun run bench --backend postgres                # or pglite
bun run bench --scenario hot-actor,state-size   # a subset
bun run bench --profile quick                   # small counts, about two minutes; for trying changes, not baselines
bun run bench --label my-change --note "why this run exists"
```

The Postgres backend needs Docker. The harness starts `postgres:18.6-bookworm` as the container `durable-actors-bench-postgres` on `127.0.0.1:55432`, with `pg_stat_statements` loaded and every durability setting at its default (`fsync`, `synchronous_commit`, and `full_page_writes` on). It removes the container when it finishes. Set `BENCH_DATABASE_URL=postgres://user:pass@host:port/db` to use an existing server instead; the harness then creates and drops one database per case on that server, which needs `CREATE DATABASE` rights and `pg_stat_statements` in `shared_preload_libraries`.

A full run takes about 25 minutes on four vCPUs, most of it in `many-actors`. Close anything else that uses CPU: the client, the runtime, and the database share the machine.

Each run writes one file per backend to `benchmarks/results/<date>-<shortsha>[-<label>]-<backend>[-quick].json`. Commit full-profile results you want others to compare against; don't edit a result file after it is committed.

## Scenarios

Each call to `withRuntime` gets a fresh database and a fresh actor runtime. Cases measured together share one: receipt replay's two cases, each state size's rewrite, hold, and wake cases, and each actor count's first-touch and steady cases. The measured actor, `Probe` in `tooling/benchmarks/src/probe/`, holds `{ count, blob }` and has default policies. `SleepyProbe` is the same actor with `hibernateAfter: 250 millis`.

| Scenario          | Cases                                                       | What it measures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hot-actor`       | `sequential`, `concurrent-8`, `concurrent-64`               | Warm command turns on one actor: one caller for latency, then 8 or 64 callers competing for its single turn slot for throughput.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `cold-activation` | `new-actor`, `after-hibernation`                            | The first turn of an activation: a never-seen actor, and a stored actor after it hibernated. `extra.reactivatedFraction` confirms that each measured turn really took a new generation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `query-latency`   | `sequential`, `concurrent-64`                               | Query handlers reading committed state, on one actor and then across 1,000 actors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `receipt-replay`  | `sequential`, `concurrent-64`                               | Retrying a committed command with the same command id, which resolves the stored receipt instead of running a turn.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `state-size`      | `rewrite-<bytes>`, `hold-<bytes>`, `wake-<bytes>`           | State of 256 B to 60 KiB, below the default 64 KiB `maxStateBytes`: rewriting the whole blob every turn, holding it while a counter changes, and waking an actor that stores it. `extra` holds the zstd-compressed size and codec timings measured off the database.                                                                                                                                                                                                                                                                                                                                                                                       |
| `many-actors`     | `first-touch-<n>`, `steady-<n>`, `steady-10000-pool-<size>` | 64 concurrent callers over 1k, 10k, and 100k actors (PGlite: 1k and 10k). First touch creates and activates each actor once; steady state then picks actors uniformly. An actor stays warm only while it is resident. A runner keeps its `maxResidentActors` activations, and idle ones hibernate after 60 seconds. So `extra.coldFraction` reports the share of steady-state turns that started a new activation, and `extra.rssDeltaMiB` and `extra.heapDeltaMiB` report memory growth during first touch, measured after a forced garbage collection. The pool sweep repeats the 10k steady state with 25 and 50 connections instead of its default 10. |

`many-actors` uses the default `maxResidentActors` of 10,000, except at 100k actors, where it raises it to 100,000. With the default, each of the 90,000 callers over the limit would retry `RunnerAtCapacity` for its whole 30-second delivery timeout.

### Adding a scenario

Add a file under `tooling/benchmarks/src/scenarios/` that exports a `Scenario`, and append it to `SCENARIOS` in `tooling/benchmarks/src/main.ts`. Use `context.withRuntime` for a fresh database and runtime, and `measure` for each case, so the case gets the same latency, throughput, statement, activity, and CPU fields as every other. If the scenario needs its own actor, define it beside `Probe` and add its layer to `ProbeLive`. A slice that adds a durable mechanism (outbox relay, timers, events, effects) adds its scenario and commits a result file from its branch.

## Reading a result

A result file has the run's context at the top and one entry per case under `scenarios[].cases[]`:

- `git`: the harness commit (`sha`), its `mainBase`, and `merges`, which lists the parents of every merge commit since `mainBase`. For a run on a local merge of unmerged pull requests, `merges` names each pull request head that was combined.
- `backend`: the Postgres or PGlite version and the server settings that affect durability and memory.
- `runtime` and `machine`: the Bun, Effect, and PGlite versions, CPU model, logical CPUs, memory, hostname, and topology. `git.dirty` is true when tracked files had uncommitted changes; such a run prints a warning and is not a baseline.
- `latencyMs`: per-operation wall time, measured by the caller, as nearest-rank percentiles (every value is an observed sample). The caller measures from before the call to after its reply, so a latency includes authorization, receipt lookup, delivery through Cluster, and the turn.
- `throughput`: successful operations per second over the measured window. `errors` counts failed operations and `errorKinds` breaks them down by error and reason, for example `ActorError/MailboxFull`. A case with errors is not a clean result.
- `statementsPerOperation`: statements `pg_stat_statements` recorded for the case's database, excluding Cluster's runner bookkeeping, divided by attempted operations (Postgres only). It records `BEGIN`, `SAVEPOINT`, and `COMMIT` once per distinct text rather than once per call, so add three for every turn transaction to get round trips. This is the one metric that doesn't depend on the machine. `statements` lists the most frequent statements for cases that ask for them.
- `activity.connections`: the mean number of the case database's client connections in each `state:wait_event` bucket, sampled every 25 ms. For example, `idle:Client/ClientRead` means a pooled connection is waiting for the runtime to send work, and `idle in transaction:Client/ClientRead` means an open transaction is waiting on the runtime between statements.
- `cpu.client` and `cpu.server`: CPU time of the benchmark process (load generator, activity sampler, actor runtime, and driver together) and of the Postgres container, as a percentage of one core over the measured window.

## Compare two runs

```sh
bun run bench:compare benchmarks/results/<before>.json benchmarks/results/<after>.json
bun run bench:compare <before> <after> --threshold 5 --fail   # exit non-zero on a regression
```

The script pairs cases by scenario and case name. It flags a regression in any of these cases:

- throughput falls by more than the threshold (default 10%);
- p50, p95, or p99 rises by more than the threshold;
- statements per operation rise by more than 0.5;
- errors increase.

It lists cases that were added or removed. It refuses to compare runs from different backends, profiles, or result schemas, and warns when the machines differ.

The `main` and `main-repeat` files show the run-to-run noise on one cloud VM. Most cases stay within 10%, but the short `state-size` cases moved by up to 63% at p50, so rerun a flagged latency case before you trust it. A change in statements per operation is real.

## Results

Every file below comes from the same machine: a 4-vCPU AMD EPYC cloud VM with 15.6 GiB of memory, running Linux 6.1. The client, the actor runtime, and Postgres share its CPUs.

| File                                           | Code                                                                                                                                                           | Backend       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `2026-09-25-6022f56-main-postgres.json`        | `main` at `76ac433` (M0 and M1.1–1.3) plus the harness; runtime code identical to `main`                                                                       | Postgres 18.6 |
| `2026-09-25-6022f56-main-pglite.json`          | same                                                                                                                                                           | PGlite 0.5.8  |
| `2026-09-25-6022f56-main-repeat-postgres.json` | the same code run again, to measure run-to-run noise                                                                                                           | Postgres 18.6 |
| `2026-09-25-a169bc7-m1-merge-postgres.json`    | local, unpushed merge of `main` `76ac433` with #34 outbox `925ae03`, #36 effects `c1ec6df`, #33 events `dd6d8f3`, and #32 reducers `ad2675b`, plus the harness | Postgres 18.6 |
| `2026-09-25-a169bc7-m1-merge-pglite.json`      | same                                                                                                                                                           | PGlite 0.5.8  |

The merge resolved conflicts locally for the benchmark only; the files' `git.merges` list the parents. The merged pull requests add no scenario of their own yet, so the merge result measures whether they slow the existing paths, not the new mechanisms.
