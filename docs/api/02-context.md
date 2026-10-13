---
title: "Context capabilities"
description: "The synchronous action, view, presence, and Effect job contexts in Akter 0.2."
---

# Context capabilities

Akter exposes different capabilities by handler phase so durable actions stay deterministic and I/O stays in jobs.

## Actions

An action receives a mutable copy-on-write draft, its decoded payload, and `{ caller, self, id, now, random, send, schedule, start, emit }`. `id()`, `now()`, and `random()` are recorded inputs. `send` and `schedule` stage fire-and-forget calls. `start` stages a job. `emit` publishes an event only after the action segment is durable.

An action is a plain synchronous function. It cannot read services, sleep, await, access `Date`, `Math.random`, `Promise`, `process`, or `globalThis`. A defect or declared failure discards the entire draft and staged consequences.

## Views

A view receives durable state, optional parameters, and `{ caller, self }`. It returns its schema value synchronously and stages nothing. Callers admitted by `access` may read state and lists directly; use a view to derive or hide a shape.

## Lists

An `Actor.list(Item, { key, by })` field supplies `get`, `range`, `put`, `delete`, and `deleteBefore` in action code. `range` uses inclusive `from`, exclusive `to`, `limit`, and `reverse`. Items are stored in content-addressed pages, so list growth does not grow the bounded actor manifest.

## Jobs

A job receives its payload and `{ self, step, emit, id, attempt }` and returns an Effect. `step(name, effect)` journals JSON or void results; pass a schema for other values. Completed steps never run again. A failed or interrupted step may have reached an external provider, so use provider idempotency keys. Calls that must not repeat across retries belong inside a step or target an idempotent action.

## Caller and access

Callers are `User { subject }`, `Anonymous`, or `System { source, subject, ref?, onBehalfOf? }`. `access(caller, request)` receives request kinds including `action`, `state`, `list`, `view`, `event`, `join`, and `find`. Internal actions are reached only by schedules, cron, jobs, failure handlers, or sends.
