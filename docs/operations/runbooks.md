---
title: "Runbooks"
description: "Respond to storage, epoch, checkpoint, job, and rollout failures without inventing authority."
---

# Operator runbooks

Each section names a failure, what is safe to do, and what is not. The rule behind all of them: only the store's durable log decides what happened. Never replace missing state with defaults.

## Storage is unavailable or an append is ambiguous

1. Stop new traffic to the unready runner and restore access to the bucket.
2. Do not report speculative state as committed.
3. Let the next epoch recover from the durable chain. An unknown append is resolved by its segment identity.
4. Retry an admitted call with the same command id.

## A runner lost its epoch

A fenced runner must close its shard and return a retryable error. Inspect the shard's durable head and owner with a separate operator grant. Do not delete advisory locks or rewrite segments: the newest create-once open is the authority.

## A page is corrupt or missing

1. Preserve the affected objects.
2. Check the page hash and the retained checkpoint chain.
3. Recover from an older intact checkpoint only if every following segment remains. Otherwise the shard stays refused.

## A build is refused or replay does not match

Run the matching retained build first. Replaying with the current build needs explicit operator authorization and is audited, and a mismatch still raises `ReplayMismatch`. Record the command id and build identities without logging payloads.

## A drain times out, or a store is stopped

Keep the runtime scope alive until the bounded drain prints `DRAINED`, and keep each shard's offset and `nextDue`. A timed-out drain is not a clean handoff. Restart a stopped store when its work is due.

## A job failed, or a sent command was rejected

Inspect the job's attempts and its `onFailure` result with scoped authority. Do not repeat completed steps to repair state.

A sent command that the target rejects is recorded at the target and counted in telemetry. There is no dead letter and no reply to the sender. Reconcile ambiguous external I/O with the provider's idempotency record.

See the [CLI reference](../api/06-cli.md) for the operator commands and the [support matrix](./support-matrix.md) for what these procedures have been tested against.
