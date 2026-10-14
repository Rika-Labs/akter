---
title: "History retention and GC"
description: "Retain recoverable segment chains and collect only unreachable pages."
---

# History retention and GC

The store descriptor records retention; the framework default is seven days. 0.2 history is retained segments and checkpoints, not event feeds or relational receipt rows. A live event is not stored and cannot be resumed from a historical cursor.

Trim deletes a segment only when it is outside retention and covered by an old-enough checkpoint. It stops at the checkpoint anchor preceding the first in-window entry and keeps the complete chain after it, even when boundary segments are older than retention. The history catalogue exposes that anchor; requested actor positions still must be in-window. Each shard's newest checkpoint also stays a root even when expired.

GC uses a create-once collector epoch and verifies that no newer epoch exists before deletion batches. It marks every retained checkpoint, each shard's newest checkpoint and retained fork/replay roots, then deletes only unreachable pages older than the grace period. Immutable publication and deletion phases exclude PUT/DELETE races; a plain PUT refresh alone cannot fence a DELETE that was already selected. An unknown deletion outcome leaves collection and publication blocked rather than risking a reachable page. An unknown publication outcome blocks them for 60 seconds: a publisher confirms its epoch after its uploads and before its reference, so the epoch can expire safely. Provider lifecycle expiry is not a substitute.

The implemented local page/fork/GC cases are recorded in [E6 evidence](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e6-pages-history.md); [ADR 0127](https://github.com/Rika-Labs/akter/blob/main/docs/decisions/0127-snapshots-pages-lists-history-gc.md) owns the anchor rule. The boundary advances to newer anchors so old roots are not retained forever. Production-provider and 50 GB gates remain unverified. Actor erasure waits until no retained checkpoint or anchor references its pages and GC's grace rule permits removal. No tenant-wide erasure API exists in 0.2.0.
