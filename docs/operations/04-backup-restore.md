---
title: "Backup and restore"
description: "Preserve a whole store and prevent two writable histories during restore."
---

# Backup and restore

A 0.2 backup includes the complete store: `meta/store`, retained segment chains, checkpoints, all reachable pages, index roots, and audit records. Copying just current actor state loses pending sends, timers, jobs, deduplication outcomes, and history. Bucket lifecycle rules must not expire live objects.

## Safe backup boundary

For an offline copy, make runners unready and drain or stop every writer before copying. Keep the build identities that may be required to replay unclean tails. Verify object hashes and gapless retained chains before treating the copy as recoverable. A provider's online snapshot or versioning feature needs its own consistency and restore evidence; the local simulator does not prove it.

## Restore

Restore into a separate empty destination with no active writer credentials. Verify the descriptor, checkpoint roots, page hashes, and tail before enabling any runner. Start the matching build, inspect recovered obligations, reconcile external effects, and only then switch traffic. Revoke or isolate the original store's writers so two writable histories cannot run the same pending work.

Command ids protect retries within retained deduplication state, not across arbitrary rollback to an older backup. External providers still need idempotency keys and reconciliation. A fork is an audited actor-history branch with fresh actor identities, not a whole-store backup.

Restore, provider snapshot consistency, and power-loss durability are not established by the E2/E3 local recovery suites. See the [recovery contract](https://github.com/Rika-Labs/akter/blob/main/docs/contracts/09-recovery.md) and [provider matrix](https://github.com/Rika-Labs/akter/blob/main/docs/verification/store-providers.md).
