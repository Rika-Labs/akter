---
title: "History retention and GC"
description: "Retain recoverable segment chains and collect only unreachable pages."
---

# History retention and GC

The store descriptor records retention; the framework default is seven days. 0.2 history is retained segments and checkpoints, not event feeds or relational receipt rows. A live event is not stored and cannot be resumed from a historical cursor.

Trim deletes a segment only when it is outside retention and covered by an old-enough checkpoint. The newest checkpoint of every shard stays a root even when older than retention. Checkpoint roots and their reachable pages must stay together.

GC uses a create-once collector epoch and verifies that no newer epoch exists before deletion batches. It marks every retained checkpoint, each shard's newest checkpoint and retained fork/replay roots, then deletes only unreachable pages older than the grace period. Immutable publication and deletion phases exclude PUT/DELETE races; a plain PUT refresh alone cannot fence a DELETE that was already selected. An unknown publication or deletion outcome leaves collection and publication blocked rather than risking a reachable page. Provider lifecycle expiry is not a substitute.

The implemented local page/fork/GC cases are recorded in [E6 evidence](../verification/e6-pages-history.md). Full retention-window forks remain blocked on the [checkpoint-anchor decision](../decisions/0138-retained-history-checkpoint-anchor.md); a recent actor version can currently become unreconstructable after its older baseline is trimmed. Production-provider and 50 GB gates remain unverified. Actor erasure is delayed until the last retained checkpoint referencing its pages ages out plus the grace period. No tenant-wide erasure API exists in 0.2.0.
