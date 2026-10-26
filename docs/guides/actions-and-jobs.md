---
title: "Actions and jobs"
description: "Keep actions synchronous and deterministic, and put I/O in journaled jobs."
---

# Actions and jobs

An action changes a copy of an actor's state and stages what should happen next. A job is an Effect that performs I/O after its start is durable. Use actions for decisions and jobs for anything that talks to the outside world.

## A failed action changes nothing

An action can declare a failure. Returning that failure discards the draft and everything the action staged.

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

When `add` returns `TooLarge`, `count` keeps its old value, and any sends, timers, job starts, and events staged by that call are dropped. The same happens when an action throws, exceeds the state size limit, or loses its write. The recorded outcome is the only trace of a failed action.

An action that returns a Promise or an Effect is a defect, not a success.

## Deterministic inputs

Actions are replayed during recovery, so they must not read the outside world. Take these from the action context instead:

| Need             | Use            |
| ---------------- | -------------- |
| A unique id      | `ctx.id()`     |
| The current time | `ctx.now()`    |
| A random number  | `ctx.random()` |

The log records these values for replay. Views follow the same rule: they read durable state and nothing else.

## Run I/O in a job

Declare a job with `Actor.job`, start it from an action, and implement it in the same `toLayer`. This example confirms an order by email:

```ts
import { Context, Effect, Schema } from "effect"
import { Actor } from "@rikalabs/akter"

class Mailer extends Context.Service<
  Mailer,
  { send(input: { to: string; key: string }): Effect.Effect<void> }
>()("Mailer") {}

const Order = Actor.make("Order", {
  state: Schema.Struct({
    status: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("new"))),
  }),
  actions: {
    place: Actor.action(Schema.String),
    confirmed: Actor.action({ internal: true }),
    failed: Actor.action(Actor.JobFailure, { internal: true }),
  },
  jobs: {
    confirm: Actor.job({
      payload: Schema.String,
      retry: { attempts: 3, backoff: "5 seconds" },
      timeout: "30 seconds",
      onFailure: "failed",
    }),
  },
})

const OrderLive = Order.toLayer({
  place: (order, email, ctx) => {
    order.status = "placed"
    ctx.start.confirm(email)
  },
  confirmed: (order) => {
    order.status = "confirmed"
  },
  failed: (order) => {
    order.status = "failed"
  },
  confirm: (email, { self, step, id }) =>
    Effect.gen(function* () {
      const mailer = yield* Mailer
      yield* step(
        "email",
        Effect.suspend(() => mailer.send({ to: email, key: id() })),
      )
      yield* step("record", self.confirmed())
    }),
})
```

- `ctx.start.confirm(email)` stages the job. It starts only after the action's segment is durable.
- `step(name, effect)` journals the result. A completed step never runs again, even if a later step causes a retry.
- `onFailure` names an internal action that takes `Actor.JobFailure`. It runs once when retries are spent.
- Internal actions are not on the client handle or `/rpc`; only the engine reaches them.

<Warning>
A failed or interrupted step may already have reached its provider. Pass an idempotency key, such as `id()` inside the step, and put job-to-actor calls that must not repeat inside a step or make the receiving action idempotent.
</Warning>

## Job events

Events emitted by an action are published after the action is durable. Events emitted by a job are published immediately and can repeat after a retry. Neither is retained, so save final results through an action.

See [Jobs](../api/jobs.md) for retries, durable sleep, and failure delivery, and the [background-work contract](https://github.com/Rika-Labs/akter/blob/main/docs/contracts/08-background-work.md) for the guarantees.
