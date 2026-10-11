# 0118: Fence owner-cache reads against the primary database

Status: accepted

## Context

[ADR 0115](0115-warm-actor-fast-path.md) permits a local committed snapshot without a database flight. A certified WAL version preserves read-your-writes, but cannot detect an ownership change after certification. It explicitly permits an undetected stale owner's tokenless read. The remaining owner-cache work carried by #714 requires a stale owner to stop answering from memory, including when no new event was emitted.

## Decision

This decision supersedes ADR 0115's zero-flight read path, not its command optimization. Every eligible cached read checks the primary database. A cache hit requires the same generation, creation marker, event head, null cold pointer and generation tuple fingerprint (`xmin:xmax:transaction-id epoch`) observed by the post-commit certification statement. Certification materializes that row once, so its provenance and fingerprint cannot come from different observations of a concurrently modified tuple. The full snapshot transaction-id epoch conservatively invalidates fingerprints across 32-bit transaction-id reuse.

Every actor writer already locks its generation row before writing. That lock changes `xmax` even before a foreign transaction becomes visible. Tuple replacement changes `xmin`. Generation or head alone would miss state-only writes and an in-flight takeover. A mismatched or unavailable fingerprint is a cache miss; transaction-id freezing, aborted locks and shared locks may cause harmless extra misses. This is not a replacement for writer fencing.

The check and conditional state load share one statement and one snapshot. They use the independent primary query pool, never the off-turn pool when that query pool exists: an off-turn job claim can wait for a running turn's generation lock, so a read on that occupied pool would create a wait cycle. On a hit, the statement returns only generation metadata; the handler decodes the immutable activation state. On a miss it returns the committed database state instead, without a second network flight. No cached value or cached version escapes a failed check. The check establishes freshness at that read's observation point, not a lock that prevents a later concurrent commit. Ordinary reads retain their existing non-materialized state query.

A minimum version must still be met by certified cache provenance. Otherwise the established replica catch-up/primary path applies. Database-dependent capabilities rerun the entire handler on the database path, never mixing cached state and current events or rows. Authorization remains before and after evaluation. Pending writes are never published, and a foreign writer in progress forces the committed database snapshot instead of memory. Missing, cold, hibernated, uncertified, grouped or query-only activations use the ordinary path. PGlite conservatively uses ordinary reads because it does not publish this independent-writer fingerprint.

## Consequences

Eligible reads use one database flight rather than zero. Compared with an ordinary one-flight state read, the improvement is avoided state transfer, decompression and reconstruction, not eliminated network latency. Small states may be slower because of the metadata check. A database outage cannot serve an unchecked cached answer. There is no public option or migration.

## Evidence

The real-database `owner cache reads:` cases in [pipeline conformance](../../tooling/conformance/src/conformance/pipeline.ts) reject unchanged-state ownership loss, a same-generation state-only commit and an in-flight foreign writer. Existing warm-path cases retain minimum-version, post-COMMIT takeover, failure, rollback and pending-turn assertions. Their historical zero-flight case now expects the intentional one-flight protocol. [BENCHMARKS.md](../../BENCHMARKS.md) records the measured tradeoff and limits; no provider or scale claim follows from local evidence.
