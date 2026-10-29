---
title: "Concepts"
description: "How actors, deterministic commands, durable segments, jobs, and live clients fit together."
---

# Concepts

## Overview

This page explains the ideas behind Akter. Read it once, then use the [Quickstart](../quickstart.md) and the [API reference](../api/01-server-api.md) for details.

## Actors and state

An actor owns schema-defined state and pending work at an address: its type and an id. `Actor.make` requires `state` and `commands`; views, broadcasts, jobs, lists, and presence are optional.

State decodes from `{}`, so fields need defaults or must be optional. Non-list state is limited to 256 KiB. For data that grows without bound, use `Actor.list`, which stores items in separate pages. See [Lists and find](../api/lists-and-find.md).

## Commands

A command is a synchronous function that edits a copy of the state. It can stage sends, timers, job starts, and broadcasts, but it cannot do I/O. If it returns its declared failure, throws, or loses its write, the whole draft and everything it staged are discarded. See [Commands and jobs](./actions-and-jobs.md), or the [commands contract](../contracts/02-actions.md) for the exact rules.

## Durability

Each shard has one owner. The owner groups commands into create-once segments in the store. A reply, broadcast, send, or job start is published only after its segment is durable.

A new segment chain starts a new epoch for the shard, and a writer from an older epoch is rejected. Lease objects and process memory are never write authority.

## Command ids

The client generates a command id for each call and keeps it across retries for ten minutes. A repeated request returns the stored outcome. Reusing an id with different input is refused.

## Jobs and timers

A job is an Effect that runs after its start is durable. It is the only place for I/O. Each `step` result is journaled, so a completed step never runs again. An interrupted external call may still have reached its provider, so use provider idempotency keys.

A command can `schedule` a call to its own actor or `send` one to another actor. Both are fire-and-forget. A command declared with `cron` runs on a schedule.

## Reads and realtime

`X.client(id)` gives a typed handle: commands are Effects, and `state`, views, list watches, and broadcasts are Streams. Presence uses a scoped `join`. Broadcasts are not stored, so a client that was not subscribed does not receive them later.

`X.find` returns actor ids filtered by top-level scalar state fields. It is not a cross-shard snapshot.

## Stores

One environment has one store, which is one bucket holding the log, checkpoints, pages, indexes, leases, and audits. Use a directory for local development. `Store.memory` is for tests only. A bucket provider is supported only after `akter storage check` passes against it; see the [support matrix](../operations/support-matrix.md).

The [runtime contracts](https://github.com/Rika-Labs/akter/blob/main/docs/contracts/README.md) state the exact guarantees.
