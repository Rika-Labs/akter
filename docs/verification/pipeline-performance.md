# Pipeline performance evaluation

Recorded on 2026-10-10 for local `ci/pipeline-performance`, based on
[the unchanged public baseline](https://github.com/Rika-Labs/akter/commit/f3c06e73c94b8e5e5de4e2c278d472830030c500).
The [evaluation thread](https://ampcode.com/threads/T-01a12410-fe1a-752d-91c8-d2f22a984d09)
retains the raw timing ledger, command logs, cache invalidation controls and
process-failure probes. This is local candidate evidence, not a hosted-after,
billing, publication or deployment claim. Cloud has a separate repository and
measurement window; its results do not establish framework support.

## Method and measured outcome

Before runs used an unchanged detached worktree. Each comparable row used three
passing repetitions on the same Mac arm64 host, with 18 CPUs and 128 GiB RAM;
Bun 1.4.2, Node 26.7.0, npm 11.19.0 and Docker 29.4.0. Commands used `CI=true`,
`GOMAXPROCS=1`, `PROPERTY_SEED=8675309` and the same nice-10 execution wrapper.
Public and Cloud measurements did not overlap.

Fresh Turbo comparisons used `--cache=local:w`: no replay and no remote writes.
Warm controls used `local:rw` and are reported separately. Compiler incremental
state was not reset, so fresh task execution is not a cold-compiler claim.
Configured-cache observations and failed experiments remain separately recorded.
No failed sample contributes to a passing-performance median.

| Command group                              | Before median | After median | Interpretation                                                                                   |
| ------------------------------------------ | ------------: | -----------: | ------------------------------------------------------------------------------------------------ |
| Root static checks and fresh source tests  |        16.14s |       13.34s | Independent validators run concurrently; 33 source tests remain fresh.                           |
| Workspace lint/typecheck, local write-only |        27.81s |       28.93s | No meaningful fresh-execution speedup.                                                           |
| Pack and real Node/Bun consumers           |       108.92s |       53.24s | Fresh build once, independent consumer verification; 51.1% less time.                            |
| Framework/conformance units                |       158.24s |       83.82s | 47.0% less time; 317 framework cases retained and one workflow-coverage guard added.             |
| Complete PGlite corpus                     |       367.98s |      313.21s | 14.9% less time; 588 pass and 252 capability skips in each repetition.                           |
| Four Postgres core projects                |       233.63s |      229.84s | Essentially unchanged; original two-command boundary retained, 386 pass and 11 capability skips. |

Separate warm controls measured 4.18s for root validators plus 33 fresh tests,
and 0.27s for workspace checks with 19/19 exact-input cache hits. Eligible CI runs
now persist successful Turbo build/lint/typecheck results, not test results.
These command medians must not be summed as the parallel workflow's wall time.

Five successful hosted-before runs measured 49.45 median summed runner-minutes,
477s required wall time and a 461s longest suite. A 1098s wall-time outlier was
job-start scheduling delay, not slow test computation. Public GitHub-hosted
minutes were already free; reduced workload is not new dollar savings.

## Retained evidence and boundaries

- Seven suite jobs remain. Only the existing PGlite pool is combined, reducing
  command groups from 21 to 19 and Vitest invocations from 22 to 20. Bun's
  integration group moves sequentially away from the formerly longest job.
- Root Vitest uses two isolated workers. Docker/subprocess drills remain serial.
  No timeout, assertion, seed count, backend case or provider gate is weakened.
- Full final CI selection passed on the real local Postgres 18.6 primary and
  physical streaming replica: Bun 967 pass/11 capability skips, Node 829 pass/11
  capability skips, 64 Node unit passes, and 22 serial crash-drill passes.
  All seven workspace test/integration tasks executed fresh with zero replays.
- The framework and conformance implementation/test bodies match the baseline,
  except for the additional workflow-selection guard. The final compiled trees
  match in bytes and modes: 402 framework files and 20 CLI files. Both consumers
  install the actual staged tarballs, typecheck
  them, and exercise persistence, restart, rollback, receipt replay, cloud API
  declarations, CLI help and `akter dev` readiness/commands/assets.
- Real-Turbo negative controls reject replayable unit tasks and root inputs that
  omit nested Markdown; a workflow mutation omitting the PGlite conformance
  project is also rejected. Restored positive guards passed.
- Nightly now uses the owning conformance workspace and Verify's Postgres
  selection, with a separate input descriptor. A subprocess consuming stdin
  otherwise loses seven project groups; the routing control detects that. The
  10,000-seed simulation schedule is unchanged, not fully rerun locally.
- Changed workflows pass actionlint. Whole-repository actionlint still reports
  pre-existing SC2086 in unchanged `stress.yml`, reproduced on the baseline.

## Failure and resource controls

Postgres pooling was rejected. All 386 assertions passed, but suite teardown
exhausted the unchanged 100-connection limit. A 106-database probe reproduced the
cleanup failure; bounded-cleanup alternatives passed but were slower (248.80s
and 251.38s medians). All pooling and fixture changes were removed, and the
original command boundary passed three times. Database limits were not raised.

A late consumer-failure probe found that the original smoke's unmanaged signal
exit orphaned a real detached CLI group. The smoke now uses `BunRuntime.runMain`
to interrupt and finalize its existing scoped child processes. Real late-phase
failure, parent interruption and stalled-CLI probes subsequently exited nonzero
with zero surviving owned processes. An earlier probe's macOS `EPERM` diagnostic
has no established cause and remains recorded; it did not recur in those final
controls. The smoke assertions and existing process-group deadline are unchanged.

The serial cold-storage drill generated a JSON measurement relative to its
conformance working directory. Its result was preserved in the root review
artifact folder and only that owned scratch directory was removed before the
final formatting checks. Disposable benchmark databases/containers were removed;
unrelated development and other-agent resources were left alone.

## Remaining proof

Hosted-after timing, cache archive/restore overhead, Linux memory pressure and
provider billing remain unknown until an authorized hosted run. Keep the pinned
toolchains, exact-input task hashing, immutable cache keys and fork/main trust
boundaries. Compare the exact shipped SHA's job/step durations and fresh test
inventories before claiming hosted runtime or cost savings. No code was pushed,
merged, published or deployed for this local evidence.

The third final CLI archive had a different checksum/compressed size from the
first two, while both consumers passed and the reported file inventory/byte
counts were unchanged. Those differing archives were not retained, so their
compressed/header/payload difference has not been attributed. The final compiled
tree comparison does not prove that every intermediate archive was byte-identical.
