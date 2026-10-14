---
title: "Self-host deployment"
description: "Deploy a bucket-backed Akter 0.2 app with bounded drain and mTLS routing."
---

# Deployment

Use one store bucket per environment and one credential scope per store. The [Compose recipe](./self-host.md) starts one runner on MinIO. For local development use `Store.fileSystem`; memory is not a durable deployment.

## Before starting

Run `akter storage check` against the actual bucket endpoint. Save its date, provider/version, target region, and probe numbers. A generic S3 API or a passing MinIO run is not production-provider validation. Give the runner only its own store's credentials and let temporary credentials refresh.

Set a stable application bundle digest and framework version through `StoreOptions.build`. The descriptor fixes shard count and retention; startup refuses conflicting configuration. Back up the whole store, not a selection of actor pages.

## Multiple runners

`Akter.serve({ app, auth, runner })` accepts reachable peer addresses and mTLS peering configuration. Cluster locks choose candidates; the log epoch fences writers. New releases start in standby and wait for a durable `Released` tail or owner expiry. Authorized releases share a store-scoped peering identity; it adds no authority beyond the store bucket credential.

## Drain and readiness

`/ready` checks registration, assignment, peer health, store verification, and drain state. Use `RuntimeControl.waitForSignal({ deadline })` inside the live runtime scope. The runner becomes unready before flushing and releasing shards, then prints `DRAINED` with durable offsets and `nextDue`. Keep the root alive until drain completes; an abrupt scope interruption is not a clean handoff.

The host must preserve matching builds for unclean tails and restart stopped stores at their earliest due work. Local E3 measurements show roughly 15-second clean moves and 31-second crash takeover under defaults, not the five-second target. See [E3 verification](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e3-cluster.md).
