---
title: "Runbooks"
description: "Respond to bucket, epoch, checkpoint, job, and rollout failures without inventing authority."
---

# Operator runbooks

## Storage unavailable or ambiguous append

Stop new traffic to an unready runner and restore provider access. Do not report speculative state as committed. An unknown append is resolved by its segment identity; the next epoch recovers from the durable chain. Use the same command id when retrying an admitted call.

## Lost epoch

A fenced runner must close its shard and return a retryable reason. Inspect the shard's durable head and owner through a separate grant. Do not repair by deleting advisory locks or rewriting segments; the newest create-once open is authority.

## Corrupt or missing page

Preserve the affected objects and check the hash and retained checkpoint chain. Recovery may use an older intact checkpoint only when all required following segments remain. Otherwise refuse the shard. Never replace missing state with defaults.

## Refused build or replay mismatch

Run the matching retained build first. Current-build replay requires explicit operator authorization and an audit; a mismatch still stops. Record the command id and build identities without logging payloads.

## Drain and stopped stores

Keep the runtime scope alive until its bounded drain reports `DRAINED`. Preserve offsets and `nextDue`. A timed-out report is not a clean handoff. Restart a stopped store when due work must run; Cloud wake orchestration needs hosted evidence.

## Failed jobs and sent actions

Inspect job attempts and the internal `onFailure` result with scoped authority. Completed steps must not be repeated to repair state. A sent action rejection is recorded at the target and counted in telemetry; it has no dead letter or reply to the sender. Reconcile ambiguous external I/O with the provider's idempotency record.

The [CLI reference](../api/06-cli.md) names implemented checks and target operator forms; the [support matrix](./support-matrix.md) bounds what these procedures have proven.
