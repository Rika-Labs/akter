---
title: "History retention and GC"
description: "How long Akter keeps recoverable history, how to change it, and how garbage collection removes pages."
---

# History retention and GC

Akter keeps history as retained segments and checkpoints. This page explains how long they are kept, how to change that, and when garbage collection (GC) deletes data.

## What is retained

A new store keeps history for seven days. The default comes from `StoreOptions.retention`, and the store records it. 0.2 history is not an event feed or a set of receipt rows. A live event is not stored and cannot be resumed from a cursor.

## Change retention

Retention can be set from 1 to 365 days with `Store.setRetention` or `akter retention`. It needs a store-wide `retention.set` operator grant. See [Store retention](../api/01-server-api.md#store-retention).

Widening keeps history that is still stored but cannot restore history already trimmed.

## How trimming works

Trim deletes a segment only when it is outside retention and covered by a checkpoint that is old enough. It stops at the checkpoint anchor before the first in-window entry and keeps the complete chain after that anchor, even if segments near the boundary are older than retention. Each shard's newest checkpoint also stays a root even when it has expired. The history catalogue exposes the anchor, and a requested actor position must still be in the window.

## How GC works

GC takes a create-once collector epoch and checks that no newer epoch exists before each batch of deletions. It marks every retained checkpoint, each shard's newest checkpoint, and the retained fork and replay roots. It then deletes only unreachable pages older than the grace period.

Publication and deletion run in separate phases, so a plain PUT refresh cannot protect a page whose deletion was already selected. If the outcome of a deletion is unknown, collection and publication stay blocked rather than risk deleting a reachable page. If the outcome of a publication is unknown, they are blocked for 60 seconds.

Do not use a provider lifecycle rule to expire objects. It cannot replace GC.

## Erase an actor's data

Actor erasure waits until no retained checkpoint or anchor references its pages and the GC grace period allows removal. There is no tenant-wide erasure API in 0.2.

Local evidence covers pages, forks, and GC ([evidence](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e6-pages-history.md)). Production-provider and 50 GB runs are not yet established.
