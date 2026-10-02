# ADR 0018: Benchmark harness and committed results

**Status:** superseded (2026-10-01). The benchmark CLI, stored results directory, benchmark scripts, and `Statements` CI job were removed. [BENCHMARKS.md](../../BENCHMARKS.md) is the consolidated record of the performed runs, comparisons, failures, fixes, published vendor measurements, and limitations. Accepted 2026-09-25. The decision below is historical, not an instruction to recreate the harness.

## Replacement decision

Run the comparison serially on clean, cgroup-limited Daytona hardware, keeping agent work and repository verification on Dallen's Mac. Preserve the report in one root file rather than maintaining a benchmark workspace or a statements gate. Do not add Markdown, link, or evidence linters. Runtime regression tests remain part of ordinary code verification.

The restart drills exposed stale Postgres sessions holding shard advisory locks after a vanished runner and startup/shutdown SQLSTATEs being mistaken for deterministic actor defects. The runtime now requests server TCP keepalive defaults for its three pools, preserving caller overrides, and retries shutdown/recovery and resource-exhaustion codes rather than inventing a permanent failure. Dropped databases and configuration limits remain non-retryable. This changes recovery policy, not the database's authority or the atomic receipt/state transaction; the owning [recovery contract](../contracts/09-recovery.md) records the boundary. The report documents measured recovery separately from the probe settings, and does not claim pooler or provider support without evidence.

## Context

[Performance](../../BENCHMARKS.md) requires measured numbers, with a reproducible command, fixture, and raw result, before any estimate becomes a claim. ADRs 0005, 0006, and 0011 size shards and set latency and throughput targets from published benchmarks, but nothing has measured this runtime. Each later slice (outbox, timers, events, effects) also changes the turn path, so every change needs a baseline it can be compared against.

The [repository structure](../architecture/repository-structure.md) requires an ADR for a new top-level directory and for a new workspace package.

## Decision

- The harness is the workspace package `@durable-actors/benchmarks` in `tooling/benchmarks/`. It is tooling, not product code: it imports the framework only through its public `durable-actors` and `durable-actors/runtime` entries, and it is linted, typechecked, and unit-tested like any other workspace.
- `bun run bench` runs every scenario against a disposable Postgres 18 container that the harness starts itself, then against in-process PGlite. `BENCH_DATABASE_URL` points it at an existing server instead. Each group of measured cases gets a fresh database and a fresh actor runtime.
- Results are data, kept in the new top-level `benchmarks/` directory: `benchmarks/results/<date>-<shortsha>[-<label>]-<backend>.json`, one file per run and backend, never edited after it is committed. Each file records the git SHA and any merge parents, the backend version and settings, the runtime versions, the machine, the parameters, and raw percentiles. `benchmarks/README.md` explains how to run, read, and compare results; `bun run bench:compare` diffs two files and flags regressions.
- Each scenario is one file in `tooling/benchmarks/src/scenarios/` (scale and memory scenarios in `scenarios/scale/`, so the folder stays under the module limit), registered in `main.ts`. A slice that adds a durable mechanism adds its scenario and commits a result from its branch.

## Alternatives

- **Harness and results together under `benchmarks/`:** rejected. A top-level code directory outside the owned roots escapes the per-file structure lint, and results would sit inside a workspace package.
- **Results as CI artifacts only:** rejected for now. CI runners change hardware between runs and artifacts expire, so they cannot serve as a baseline. A dedicated benchmark runner can take over when one exists.
- **A benchmark library such as mitata or tinybench:** rejected. Those time synchronous micro-operations; these scenarios are concurrent, database-bound Effect programs that need statement counts and connection sampling.

## Consequences

Numbers come from whichever machine ran them. A result file names that machine, and the performance document labels measured values with it. Results from different machines are not comparable, so a regression check must compare two runs from the same machine. PGlite results never stand in for lock contention or multi-process Postgres behavior.

## Evidence and revisit conditions

`tooling/benchmarks/src/measure.test.ts` and `compare.test.ts` cover the percentile, load, and regression logic. The first results are in `benchmarks/results/`. Revisit when a dedicated benchmark machine or a hosted Neki environment exists, or when result files become too large to review in a pull request.
