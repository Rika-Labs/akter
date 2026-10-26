---
title: "Self-host deployment"
description: "What to prepare before you run Akter on your own infrastructure: the store, runners, and shutdown."
---

# Self-host deployment

This page lists what you are responsible for when you run Akter yourself. For a working setup, start with the [Docker Compose recipe](./self-host.md), which runs one runner on MinIO.

## Before you start

- Use one store bucket per environment and one credential scope per store. Give a runner only its own store's credentials, and let temporary credentials refresh.
- Run [`akter storage check`](../api/06-cli.md#akter-storage-check) against the real bucket endpoint. Save the date, provider and version, region, and probe numbers. A generic S3 API or a passing MinIO run does not validate your provider.
- Set `StoreOptions.build` to a stable bundle digest and the framework version. The store records the shard count and retention when it is created, and a conflicting configuration is refused at startup.
- Back up the whole store, not a selection of actor pages. See [Backup and restore](./04-backup-restore.md).
- Use `Store.fileSystem` for local development only. `Store.memory` is not durable.

## Run several runners

`Akter.serve({ app, auth, runner })` takes a runner with a reachable peer address and mutual TLS peering. Runners coordinate shard ownership through the bucket. Cluster locks choose a candidate owner, and the log epoch fences writers, so a lock alone never authorizes a write.

A new release starts in standby and waits for the old owner's durable `Released` entry or for the old owner's lock to expire. All authorized releases of a store share one peering identity. It adds no authority beyond the store's bucket credential.

## Shutdown and readiness

`GET /ready` reports whether the runner is ready. Use `RuntimeControl.waitForSignal({ deadline })` inside the live runtime scope so SIGTERM and SIGINT start a drain. The runner becomes unready, flushes and releases its shards, and prints a `DRAINED` report with the durable offsets and `nextDue` for each shard.

Keep the process alive until the drain finishes. An abrupt interruption is not a clean handoff.

## What your host must do

- Keep the build that wrote an unclean tail, so a matching build can recover it.
- Persist each `DRAINED` report and restart a stopped store when its `nextDue` passes. The engine cannot wake a stopped process.

## Handoff timing

With the default timings on one developer machine (local MinIO and a local directory, 12 runs), clean handoffs took 1.1 to 3.6 seconds and crash takeover took 3.6 to 5.9 seconds. Four of the 12 crash takeovers took longer than the five-second target. These are not provider measurements. See the [cluster evidence](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e3-cluster.md).
