---
title: "Concepts"
description: "Actors, deterministic actions, durable segments, jobs, and live Effect clients."
---

# Concepts

## Actors and state

An actor owns schema state and pending work at a typed address. `Actor.make` requires `state` and `actions`. State decodes from `{}` with field defaults or optional fields. `Actor.list` stores unbounded items separately in content-addressed pages, outside the 256 KiB non-list state limit.

## Actions and durability

A synchronous action changes a copy-on-write draft. It can stage sends, timers, jobs, and events, but performs no I/O. Declared failure, defect, page miss, or lost append discards the entire draft and every staged consequence. One shard owner groups entries into create-once segments. Replies and published consequences wait for a durable segment.

## Command ids and epochs

The client generates a command id and keeps it across transport retries for ten minutes. A repeated request returns the stored outcome; changed input under an id is refused. Derived work has its own stream identity. A new open segment creates the shard epoch and fences stale writers. Lease objects and process memory are never write authority.

## Jobs and timers

Jobs run Effects after durable start. Completed `step` results never repeat; interrupted I/O can still need a provider idempotency key. `schedule` targets the actor itself and `send` targets another actor, both fire-and-forget. Cron is an action option and arms per-instance timers.

## Reads and realtime

`X.client(id)` exposes typed action Effects and live state, list, view, and event Streams. Presence is a scoped `join`. Events are not retained. `X.find` returns ids only from top-level scalar state and is not a cross-shard snapshot.

## Store and hosting

One environment has one bucket store containing log, checkpoints, pages, indexes, leases, and audits. Development uses a filesystem directory; memory is test-only. A provider is supported only with its own passing protocol evidence. The [contracts](../contracts/README.md) state guarantees and the [support matrix](../operations/support-matrix.md) bounds support.
