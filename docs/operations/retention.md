---
title: "History retention and GC"
description: "Retain recoverable segment chains and collect only unreachable pages."
---

# History retention and GC

The store descriptor records retention; the framework default is seven days. 0.2 history is retained segments and checkpoints, not event feeds or relational receipt rows. A live event is not stored and cannot be resumed from a historical cursor.

Trim deletes a segment only when it is outside retention and covered by an old-enough checkpoint. The newest checkpoint of every shard stays a root even when older than retention. Checkpoint roots and their reachable pages must stay together.

GC uses a create-once collector epoch and verifies that no newer epoch exists before deletion batches. It marks every retained checkpoint and each shard's newest checkpoint, then deletes only unreachable pages older than the grace period. Plain PUT refreshes a reused page's last-modified time so a concurrent snapshot cannot reference a page GC is about to remove. Provider lifecycle expiry is not a substitute.

These are E6 target guarantees, including interrupted upload and fork-versus-GC races; consult the [storage contract](../contracts/06-storage.md) and its promotion status. Actor erasure is delayed until the last retained checkpoint referencing its pages ages out plus the grace period. No tenant-wide erasure API exists in 0.2.0.
