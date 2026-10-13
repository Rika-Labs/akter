---
title: "Environment storage"
description: "One Akter-managed store bucket per environment incarnation in the 0.2 hosted design."
---

# Environment storage

Akter 0.2's hosted design provisions one store bucket for each environment incarnation. The bucket holds the command log, fencing epochs, checkpoints, pages, index, cluster bookkeeping, and audits. Redeployments reuse the store; deleting and recreating an environment creates a new store. Production, staging, dev, and preview stores are isolated.

No `DATABASE_URL` is required or supplied for the framework. There is no customer-database migration step. Self-hosters bring an S3-compatible bucket; Cloud's 0.2 design does not accept customer-provided buckets.

## Provisioning and credentials

The first deployment records a durable provisioning obligation. Before the store becomes ready, provisioning runs `akter storage check` on the actual bucket. Failure keeps the deployment visibly refused rather than weakening the storage protocol. R2 is the selected provider by decision, not a validated provider claim; local MinIO results do not establish its atomicity or latency.

Runner credentials are temporary and scoped to one bucket. The platform injects reserved `AKTER_STORE` and `AKTER_STORAGE_*` configuration and refreshes credentials through the hosted edge. Builders receive no store credential; customers cannot list or edit these values. Preview stage credentials cannot reach production stores.

## Data custody and deletion

Cloud now holds end-user actor data. The hosted target fences and retires an environment before store cleanup, stops credential minting, waits 30 days, then empties and deletes the bucket through a durable retryable obligation. This is a retention/deletion design, not a customer undelete feature. Closed disposable pull-request previews use guarded teardown without that wait.

Export what you need before deletion. Retained history and checkpoints can contain prior personal data until retention and GC finish. No provider lifecycle rule may expire live pages or history. Hosted credential isolation, refresh, deletion, and rollout support need provider-specific E8 evidence; this page does not claim those gates passed.
