---
title: "Context capabilities"
description: "What each handler can do: commands, views, presence, and jobs get different capabilities."
---

# Context capabilities

Akter gives each handler phase different capabilities, so commands stay deterministic and I/O stays in jobs.

| Handler                            | Receives                                                                              | Can do I/O             |
| ---------------------------------- | ------------------------------------------------------------------------------------- | ---------------------- |
| Command                            | Draft, payload, `{ caller, self, id, now, random, send, schedule, start, broadcast }` | No                     |
| View                               | Durable state, optional params, `{ caller, self }`                                    | No                     |
| Presence (`connect`, `disconnect`) | Draft, presence value, the command context plus `connection`                          | No                     |
| Job                                | Payload, `{ self, step, broadcast, id, attempt }`                                     | Yes, returns an Effect |

## Commands

A command edits a copy-on-write draft and returns the reply, or a declared failure.

- `id()`, `now()`, and `random()` are recorded, so replays see the same values.
- `send(target, id).command(payload)` and `schedule(when).command(payload)` stage fire-and-forget calls. `schedule` targets the same actor. `when` is a duration or `{ at: epochMillis }`.
- `start.job(payload, { key? })` stages a job.
- `broadcast.name(value)` stages a broadcast, published only after the command's segment is durable.

A command is a plain synchronous function. Returning a Promise or an Effect, or using the context after the command returns, is a defect. A defect or declared failure discards the draft and everything staged.

## Views

A view receives durable state, optional parameters, and `{ caller, self }`. It returns its schema value synchronously and stages nothing. Callers admitted by `access` can read state and lists directly. Use a view to derive a value or to hide part of the state.

## Lists

A field declared with `Actor.list(Item, { key, by })` provides these in command code:

| Method                                    | Does                                                  |
| ----------------------------------------- | ----------------------------------------------------- |
| `put(item)`                               | Insert or replace by key                              |
| `get(key)`                                | Read one item                                         |
| `delete(key)`                             | Remove one item; returns whether it existed           |
| `deleteBefore(by)`                        | Remove items ordered before `by`; returns the count   |
| `range({ from?, to?, limit?, reverse? })` | Read a window; `from` is inclusive, `to` is exclusive |

Items live in content-addressed pages, so list growth does not grow the actor's state. See [Lists and find](./lists-and-find.md).

## Jobs

A job receives its payload and `{ self, step, broadcast, id, attempt }` and returns an Effect. `step(name, effect)` journals JSON or void results; pass a schema as the second argument for other values. A completed step never runs again. A failed or interrupted step may already have reached an external provider, so use provider idempotency keys. See [Jobs](./jobs.md).

## Callers and access

A caller is one of:

| Caller      | Fields                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `User`      | `subject`                                                                                                        |
| `Anonymous` | none                                                                                                             |
| `System`    | `source` (`send`, `timer`, `cron`, `job`, `operator`, `process`), `subject`, and optional `ref` and `onBehalfOf` |

`access(caller, request)` decides whether a request is admitted. `request.kind` is `command`, `state`, `list`, `view`, `broadcast`, `join`, `find`, or `reauthorize`, and `request.member` names the member. The default admits `User` and `System` only. Internal commands are reached only by the engine: schedules, cron, jobs, failure handlers, and sends.
