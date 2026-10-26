---
title: "Environment storage"
description: "How Akter Cloud stores your actors' data, who manages it, and what happens when you delete an environment."
---

# Environment storage

Every environment on Akter Cloud has its own private store: one bucket that holds your actors' durable data. Akter creates the bucket, manages its credentials, retains its history, and deletes it. You never provision a database or a bucket, and Akter Cloud does not accept a bucket you bring yourself. To use your own bucket, [self-host](../operations/self-host.md).

## What the store holds

The store holds everything the runtime needs to recover: the command log, checkpoints, pages, index pages, history, and the leases that decide which runner owns each shard. Your actors' state lives here, not in the runner, so a new deployment continues from the same data.

Production, staging, and dev have separate stores, and a runner's credentials reach only its own store. Redeploying reuses the environment's store. If you delete an environment and create it again with the same name, you get a new, empty store.

## Creation and checks

The first deployment to an environment creates its store. Before your app serves traffic from a new store, the runner runs [`akter storage check`](../api/06-cli.md#akter-storage-check) against it. If a probe fails, the store is marked `failed` and the app does not serve until a later deployment passes the check.

The console's Storage page shows the store's state, which is one of `absent`, `provisioning`, `ready`, `retiring`, `deleted`, or `failed`. It also shows the bucket name, the last check report, and the retention windows. It does not show credentials.

## Credentials

You cannot list or edit your runners' store credentials, and builders never receive them. The platform sets the `AKTER_STORAGE_*` variables on your runners; those names are reserved, as described in [Environment variables](./environment-variables.md).

## Retention

Akter keeps each store's history for 7 days on Free and 30 days on a paid plan. History is the log of past commits. It is not a feed of events, and it is not a backup that you can restore from. Akter Cloud does not offer point-in-time restore.

Lowering your plan does not trim history right away. A shorter window applies after the period you already paid for ends.

## Deleting data

When you delete an environment, project, or organization, Akter stops issuing credentials for its stores and marks them `retiring`. After 30 days, Akter empties and deletes each bucket. A failed cleanup step is retried until it completes.

Export what you need before you delete anything. Retained history and checkpoints can hold earlier versions of your data until retention and cleanup finish. See [Account and data](./account-and-data.md).
