---
title: "Backup and restore"
description: "Back up a whole store and restore it without creating two writable histories."
---

# Backup and restore

A backup must contain the whole store. Copying only current actor state loses pending sends, timers, jobs, deduplication outcomes, and history.

## What a backup contains

A complete 0.2 backup holds `meta/store`, the retained segment chains, checkpoints, every reachable page, index roots, and audit records. Bucket lifecycle rules must never expire live objects.

## Back up safely

1. Make runners unready, then drain or stop every writer.
2. Copy the store.
3. Keep the build identities you may need to replay unclean tails.
4. Verify object hashes and that each retained chain has no gaps before you treat the copy as recoverable.

A provider's online snapshot or versioning feature needs its own evidence that it is consistent and restorable. The local simulator does not show that.

## Restore

1. Restore into a separate, empty destination with no active writer credentials.
2. Verify the store descriptor, checkpoint roots, page hashes, and the tail before you enable any runner.
3. Start the matching build and inspect the recovered obligations.
4. Reconcile external effects with your providers.
5. Switch traffic.

<Warning>
Revoke or isolate the original store's writers, so two writable histories cannot run the same pending work.
</Warning>

Command ids protect retries only within the retained deduplication state, not across a rollback to an older backup. External providers still need idempotency keys and reconciliation.

A [fork](../api/forks.md) branches one actor's history under new actor ids. It is not a backup of the store.

## What is not proven

The local recovery tests do not cover restore, provider snapshot consistency, or power-loss durability. See the [recovery contract](https://github.com/Rika-Labs/akter/blob/main/docs/contracts/09-recovery.md) and the [provider matrix](https://github.com/Rika-Labs/akter/blob/main/docs/verification/store-providers.md).
