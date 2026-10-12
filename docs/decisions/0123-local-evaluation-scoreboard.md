# ADR 0123: Maintained local evaluation scoreboard

**Status:** accepted (2026-10-11).

## Context

The release evaluation needs reproducible same-host comparisons across the
served workload set, not another collection of outside-tree hot-key scripts.
The local evaluation charter replaces ADR 0018's replacement decision against
maintaining a benchmark workspace. Runtime regression suites remain correctness
gates; timing is not an ordinary CI gate.

## Decision

Maintain the private `@akter/bench` workspace under `tooling/bench`. Adapt the
existing served counter, real Postgres, and kernel-delay fixtures. Comparisons
freeze both git sources, keep their dependency locks, alternate at least three
rounds on the same host, and start a fresh database and runner for every case.
Retain raw JSON and generate Markdown with per-case medians and ranges. Never
pool latency samples across repeats or call overlapping ranges an improvement.

The manually dispatched benchmark workflow uses one fixed runner type and
uploads evidence. It has no schedule and is not a merge gate. CI comparisons
are the reference; the shared Mac supplies quick signals only. Results remain
outside the source tree or in workflow artifacts, rather than a new top-level
results directory.

Measure process CPU and Postgres container CPU separately. Statement execution
time from `pg_stat_statements` is elapsed time, not CPU attribution. Instrumented
wire budgets and CPU profiles are separate diagnostic runs, never timing samples.
Local cold storage establishes framework export/restore behavior only, not an
object-storage provider's performance.

## Consequences

The workspace participates in lint, typecheck and focused tests. Workload
outcomes, durable state and receipt counts must agree before a timing result is
usable. Errors, refusals, missed open-loop deadlines and measurement limitations
remain visible in the raw evidence and report. A missing observation is unknown,
not zero or a pass.
