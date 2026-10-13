# E6 pages, history, GC and forks

Status: locally implemented and verified for actor forks. Production-provider gates, the 50 GB workload and whole-shard forks are not established. Local measurements are in [the benchmark ledger](../../BENCHMARKS.md).

## Failure evidence

`handlers/page-tree.test.ts` rejects eager list loading, unbounded cache growth, key/order confusion and full-tree rewrites. `store/gc.test.ts` covers retained roots, retention boundaries, immutable-epoch races, unknown delete outcomes, publication barriers, deduplication refresh, confirmed owner fencing and seeded collectors. `tooling/conformance/src/conformance/pages.ts` runs the same F20–F22 fixture on filesystem and S3/MinIO backends, including copied job steps under new ids. `snapshots/pages.test.ts` runs 40 two-runner fork/GC/replay seeds with moves from runner 0 to 1 and back, eight exact byte-replay pairs, 20 corrupt-page owner-move seeds and the seed-900 retention boundary on Bun and Node.

The seed-900 scenario retains an expired baseline and the complete boundary tail, trims only through that baseline, forks an in-window version after an owner move, refuses an expired version, then advances retention and collects the old anchor without losing the fork. The shared filesystem/MinIO scenario also recovers an actor changed only in the expired boundary tail. Its expected item 17, item 29, count and full key set distinguish the requested version from either checkpoint. The seeded scenario checks whole-history invariants before trim and uses direct test-clock expiry afterwards because those I1/I2 checks require the deliberately deleted prefix; it then asserts the retained state and physical object deletion directly. The existing untrimmed I1/I2 scenarios are unchanged.

The page-backed replay scenario requires `Replayed` and `Audit` in one segment and identical state/index checkpoint roots. It removes all checkpoint manifests, runs GC after the page grace period, and reopens from the replay entry alone. This rejects checkpoint-only GC roots and an inline scalar fallback that loses list state. It is real bucket reachability/recovery evidence, not a simulated checkpoint-upload interruption.

`snapshots/recovery.test.ts` retains the latest-checkpoint assertion and adds immutable workflow-capture and delayed-upload prefix regressions. Together with index seed 2301 and the 1,000 faulted simulator seeds, these cover checkpoint-prefix capture before asynchronous work, atomic publication of a complete segment before telemetry yields, and generation fencing of stale committer continuations.

| Requirement                               | Evidence                                                                                    | Wrong implementation rejected                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| F20 fork during writes and fork of fork   | concurrent source action and version-qualified fork; restart and independent source values  | current-state copy, incorrect lineage, copied work by default         |
| F21 GC racing checkpoint/fork             | two collectors, protected publication and retained Forked manifest roots                    | process-local exclusion, shallow mark, checkpoint-only roots          |
| F21′ old deduplicated page                | hold DELETE after selection, refuse publication, then reupload and publish a checkpoint     | an old dedup page deleted after a durable reference                   |
| F22 corrupt cold page                     | overwrite an interior-referenced leaf, reopen or move owners and range-read                 | default or partial list state after digest mismatch                   |
| I6 checkpoint plus tail equals live state | seeded independent replay from every checkpoint                                             | lazy tree restore diverges from live state                            |
| I7 reachable pages survive GC             | recursive verified root traversal and raced seeded collectors                               | newest-only or shallow roots, missing retained fork root              |
| State cap                                 | oversized scalar draft stages a timer/event but preserves old state and timer obligations   | publishing staged work from a discarded draft                         |
| Retention anchor                          | seed 900 on simulator, filesystem and MinIO; expired baseline/tail and later anchor release | timestamp-only pruning, missing boundary entries, permanent old roots |
| Page-backed operator replay               | replay/audit segment, removed checkpoint manifests, GC and cold owner recovery              | separate audit publication, checkpoint-only reachability, lost lists  |

The state cap remains 256 KiB encoded without lists. The clean page cache is byte-bounded; invocation-local working sets may exceed it to finish wide reads. Missing cache pages rerun the action with the same deterministic inputs, while missing bucket objects and digest corruption stay `PageCorrupt` defects.

## Protocol limits

Retained segments are the archive; there is no mutable archive pointer and no separate copy before trim. Store retention comes from `meta/store`. The expired anchor exists to reconstruct in-window positions, not to authorize expired requests. Its complete following chain is retained and rooted until the boundary advances. Provider timestamps remain provider evidence, not simulated timestamps.

The bucket interface has no conditional DELETE. A page HEAD/timestamp check cannot fence a concurrent PUT, so publication and delete epochs share a store-wide immutable barrier. Unknown outcomes strand it safely; automatic recovery of a stranded publisher/delete epoch is not established. Collection is exposed as `Store.collect`, not a Cluster Singleton.

A protected checkpoint refused by a confirmed owner fence releases its publication exclusion after the work has stopped. Both filesystem and simulated bucket regressions then require another collector to run; they keep unknown-outcome cases blocked instead.

Fork authority currently supports only the default tenant; nondefault and cross-scope requests are refused. Whole-shard copying and hosted operator transport are not claimed by the actor-fork command. No R2/Tigris or 50 GB collection performance claim is made from local filesystem/MinIO tests.
