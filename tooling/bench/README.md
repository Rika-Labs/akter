# Local evaluation scoreboard

This private workspace measures the real served public API on Postgres 18.6.
It adapts the retained S22 counter/driver/kernel-delay harness. It is not a
microbenchmark or a provider certification.

```sh
bun run --cwd tooling/bench test
bun run --cwd tooling/bench compare v0.1.0-alpha.6 89e8af89
```

Docker and Bun 1.4.2 are required. The Docker VM must expose at least four
logical CPUs. The command owns only uniquely named disposable resources and
does not accept an existing database. Every case gets a fresh Postgres cluster
and runner process. Both refs are archived and installed independently from
their original frozen locks; the same current harness runs on both. No production
dependency or checked-out source is mutated.

The runner, database, relay and driver use CPU sets 0/1/2/3 and one-CPU quotas.
Synchronous commits and stock 100 connections remain enabled. Kernel netem
adds 1.25 ms per database direction. Three rounds run each case base/head,
head/base, base/head, on the same host. These are not exclusive physical cores
on a shared Mac. Use the **Benchmark reference** manual workflow's uploaded
evidence as the reference, not absolute Mac timings. Its runner type is fixed
to `ubuntu-24.04`; it has no schedule or automatic merge gate.

## Cases and evidence

The set covers sequential writes, one-key writes with 64 callers, writes over
10,000 keys, sequential reads, reads over 1,000 keys, new keys, and offered
open-loop rates of 200/500/1,000/2,000 writes/s over 1,000 keys. Every spread
cohort uses the same deterministic unsigned key stream. Existing keys are
acknowledged before a three-second warmup and 20-second measurement. Sequential
and closed-loop workloads drain in-flight requests at the end. Open-loop
latency starts at the scheduled arrival, so queueing and scheduler delay are
not hidden by coordinated omission. Offered duration, final drain time,
maximum scheduler lag and a bounded driver's dropped arrivals are retained.
Refusals are counted, not retried into a successful-only load.

Idle and cold wakes first prove zero resident activations from the public
metric. Cold additionally proves a durable pointer exists before every wake,
and verifies successful restoration clears it. These cases use natural
hibernation, never a simulated clock. Cold object storage is local memory:
this measures the framework path, not S3 or network object I/O. Lifecycle CPU
windows include the waits between five wakes and background housekeeping;
only individual request latencies describe wake latency. Resident RSS uses
full GC before first touch and after 10,000 acknowledged actors, verifies the
activation gauge, and divides the process RSS delta by that gauge. RSS includes
allocator high-water capacity, not only retained actor heap.

Every acknowledgement is checked against independent expected values. Each
key's write replies must contain the complete distinct sequence of multiples
of three. Durable decompressed state, total receipts and measured receipt
delta must agree. Read cohorts must return the setup values and add no receipts.
Failures, refusals, timeouts, dropped arrivals and storage disagreement remain
in the output and suppress comparison verdicts, rather than disappearing from
latencies. A timeout is not evidence that the command failed to commit.

Raw JSON retains successful per-request latencies, CPU snapshots, SQL statement
statistics, counts and fixture parameters. JSON and Markdown reports summarize
each run's nearest-rank percentiles separately using repeat medians and min/max
ranges. Only disjoint observed ranges receive an improvement/regression flag;
touching or overlapping ranges are inconclusive, not statistically significant.

App CPU is process user+system CPU. DB CPU is actual Postgres-container cgroup
usage, including background processes. `pg_stat_statements.total_exec_time`
is reported separately as **SQL elapsed time**, never mislabeled SQL CPU.
Instrumented diagnostic runs count turn-pool frontend writes and Execute
statements; these budgets exclude keeper, registration and query pools and do
not enter timing comparisons. Timing runs report unknown wire counts, not zero.

`BENCH_PROFILE_CASES=hot-write,spread-write` adds Bun CPU and sampled heap profiles to the
separate diagnostic runs. Profiles carry the same frozen sources and fixture
but never replace an uninstrumented timing repeat. Heap profiles are allocation
sampling evidence, not an independently measured total allocation rate.

## Controls and retention

`BENCH_OUTPUT` selects a new absolute output directory (reuse is refused).
The default is a unique directory under `~/.capy/work/akter-bench`. Raw repeats,
order, frozen build contexts, source/harness hashes, image identities, host
metadata and build/server logs remain there. The manual workflow uploads JSON,
Markdown, metadata and logs for 90 days. Keep the artifact with any performance
claim; artifact expiry does not establish a new baseline.

For a quick smoke check, set `BENCH_SECONDS=1`, `BENCH_WARMUP_SECONDS=0`,
`BENCH_WAKE_REPEATS=1`, `BENCH_DIAGNOSTICS=0` and optionally
`BENCH_CASES=sequential-write,sequential-read`. Reduced runs are fixture checks,
not the release comparison. `BENCH_ROUNDS` may increase but never drop below
three. Do not overlap timing runs with builds, tests, profiles or other loads.
