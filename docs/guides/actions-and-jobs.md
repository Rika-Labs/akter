---
title: "Actions and jobs"
description: "Keep durable actions synchronous and deterministic; put I/O in journaled Effect jobs."
---

# Actions and jobs

An action changes a copy-on-write draft and stages consequences. It is a synchronous function, not an Effect. A job is an Effect that can call services and perform I/O after its start is durable.

## Declared failures discard everything

```ts
import { Effect, Schema } from "effect"
import { Actor } from "@rikalabs/akter"

class TooLarge extends Schema.TaggedError<TooLarge>()("TooLarge", {}) {}

const Counter = Actor.make("Counter", {
  state: Schema.Struct({
    count: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  actions: {
    add: Actor.action(Schema.Number, { success: Schema.Number, fails: TooLarge }),
  },
})

const CounterLive = Counter.toLayer({
  add: (counter, amount) => {
    counter.count += amount
    if (counter.count > 100) return new TooLarge({})
    return counter.count
  },
})
```

Returning `TooLarge` discards the draft. The same rule applies to staged sends, timers, job starts, and events, not just state. A defect, state-size violation, page miss, or lost append also publishes no speculative work. The recorded outcome is the only surviving trace of a failed action.

## Deterministic inputs

Use `ctx.id()`, `ctx.now()`, and `ctx.random()` when an action needs those values. The log records them for replay. Direct clock reads, random sources, global process state, asynchronous code, and non-deterministic formatting are forbidden by `akter/synchronous-actions`. Views have the same synchronous restriction and can only read durable data.

## Journal I/O in jobs

Declare `Actor.job({ payload, retry, timeout, concurrency, onFailure })` and implement it in the same `toLayer` as actions. Start it with `ctx.start.notify(payload)`. `onFailure` must name an internal action accepting `Actor.JobFailure`.

Use `step("send", effect)` for JSON or void results, or `step("send", ResultSchema, effect)` for another schema value. A completed step never runs again. An interrupted external call can still have reached its provider before its result was journaled, so provider idempotency remains necessary. Put job-to-action calls that must not repeat across retry attempts inside a step, or make the action idempotent.

Events emitted by an action wait for durability. Job progress events publish immediately and may repeat after retry; they are not retained history. Persist final results through an action. See [jobs](../api/jobs.md) and the [background-work contract](../contracts/08-background-work.md).
