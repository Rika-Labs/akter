# E6 pages, history, GC and forks

Status: locally implemented and verified for actor forks. Production-provider gates, the 50 GB workload and whole-shard forks are not established. Local measurements are in [the benchmark ledger](../../BENCHMARKS.md).

## Failure evidence

`handlers/page-tree.test.ts` rejects eager list loading, unbounded cache growth, key/order confusion and full-tree rewrites. `store/gc.test.ts` covers retained roots, retention boundaries, immutable-epoch races, unknown delete outcomes, publication barriers, deduplication refresh, confirmed owner fencing and seeded collectors. `tooling/conformance/src/conformance/pages.ts` runs the same F20–F22 fixture on filesystem and S3/MinIO backends, including copied job steps under new ids. `snapshots/pages.test.ts` runs 40 two-runner fork/GC/replay seeds with moves from runner 0 to 1 and back, eight exact byte-replay pairs, and 20 corrupt-page owner-move seeds on Bun and Node.

| Requirement                               | Evidence                                                                                   | Wrong implementation rejected                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| F20 fork during writes and fork of fork   | concurrent source action and version-qualified fork; restart and independent source values | current-state copy, incorrect lineage, copied work by default |
| F21 GC racing checkpoint/fork             | two collectors, protected publication and retained Forked manifest roots                   | process-local exclusion, shallow mark, checkpoint-only roots  |
| F21′ old deduplicated page                | hold DELETE after selection, refuse publication, then reupload and publish a checkpoint    | an old dedup page deleted after a durable reference           |
| F22 corrupt cold page                     | overwrite an interior-referenced leaf, reopen or move owners and range-read                | default or partial list state after digest mismatch           |
| I6 checkpoint plus tail equals live state | seeded independent replay from every checkpoint                                            | lazy tree restore diverges from live state                    |
| I7 reachable pages survive GC             | recursive verified root traversal and raced seeded collectors                              | newest-only or shallow roots, missing retained fork root      |
| State cap                                 | oversized scalar draft stages a timer/event but preserves old state and timer obligations  | publishing staged work from a discarded draft                 |

The state cap remains 256 KiB encoded without lists. The clean page cache is byte-bounded; invocation-local working sets may exceed it to finish wide reads. Missing cache pages rerun the action with the same deterministic inputs, while missing bucket objects and digest corruption stay `PageCorrupt` defects.

## Protocol limits

Retained segments are the archive; there is no mutable archive pointer and no separate copy before trim. Store retention comes from `meta/store`. Provider timestamps remain provider evidence, not simulated timestamps.

The bucket interface has no conditional DELETE. A page HEAD/timestamp check cannot fence a concurrent PUT, so publication and delete epochs share a store-wide immutable barrier. Unknown outcomes strand it safely; automatic recovery of a stranded publisher/delete epoch is not established. Collection is exposed as `Store.collect`, not a Cluster Singleton.

A protected checkpoint refused by a confirmed owner fence releases its publication exclusion after the work has stopped. Both filesystem and simulated bucket regressions then require another collector to run; they keep unknown-outcome cases blocked instead.

Fork authority currently supports only the default tenant; nondefault and cross-scope requests are refused. Whole-shard copying and hosted operator transport are not claimed by the actor-fork command. No R2/Tigris or 50 GB collection performance claim is made from local filesystem/MinIO tests.
