---
title: "Commands and jobs"
description: "Keep commands synchronous and deterministic, and put I/O in journaled jobs."
---

# Commands and jobs

A command changes a copy of an actor's state and stages what should happen next. A job is an Effect that performs I/O after its start is durable. Use commands for decisions and jobs for anything that talks to the outside world.

## A failed command changes nothing

A command can declare a failure. Returning that failure discards the draft and everything the command staged.

```ts
import { Effect, Schema } from "effect"
import { Actor } from "@rikalabs/akter"

class TooLarge extends Schema.TaggedError<TooLarge>()("TooLarge", {}) {}

const Counter = Actor.make("Counter", {
  state: Schema.Struct({
    count: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  commands: {
    add: Actor.command(Schema.Number, { success: Schema.Number, fails: TooLarge }),
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

When `add` returns `TooLarge`, `count` keeps its old value, and any sends, timers, job starts, and broadcasts staged by that call are dropped. The same happens when a command throws, exceeds the state size limit, or loses its write. The recorded outcome is the only trace of a failed command.

A command that returns a Promise or an Effect is a defect, not a success.

## Deterministic inputs

Commands are replayed during recovery, so they must not read the outside world. Take these from the command context instead:

| Need             | Use            |
| ---------------- | -------------- |
| A unique id      | `ctx.id()`     |
| The current time | `ctx.now()`    |
| A random number  | `ctx.random()` |

The log records these values for replay. Views follow the same rule: they read durable state and nothing else.

## Run I/O in a job

Declare a job with `Actor.job`, start it from a command, and implement it in the same `toLayer`. This example confirms an order by email:

```ts
import { Context, Effect, Schedule, Schema } from "effect"
import { Actor, Job } from "@rikalabs/akter"

class Mailer extends Context.Service<
  Mailer,
  { send(input: { to: string; key: string }): Effect.Effect<void> }
>()("Mailer") {}

const Order = Actor.make("Order", {
  state: Schema.Struct({
    status: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("new"))),
  }),
  commands: {
    place: Actor.command(Schema.String),
    confirmed: Actor.command({ internal: true }),
    failed: Actor.command(Actor.JobFailure, { internal: true }),
  },
  jobs: {
    confirm: Actor.job({ payload: Schema.String, onFailure: "failed" }).pipe(
      Job.retry({ times: 2, schedule: Schedule.spaced("5 seconds") }),
      Job.timeout("30 seconds"),
    ),
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

- `ctx.start.confirm(email)` stages the job. It starts only after the command's segment is durable.
- `step(name, effect)` journals the result. A completed step never runs again, even if a later step causes a retry.
- `Job.retry({ times: 2, ... })` allows two retries after the first attempt, five seconds apart, and `Job.timeout` bounds each attempt.
- `onFailure` names an internal command that takes `Actor.JobFailure`. It runs once when retries are spent. An optional `onSuccess` names an internal command that receives the job's success value once.
- Internal commands are not on the client handle or `/rpc`; only the engine reaches them.

<Warning>
A failed or interrupted step may already have reached its provider. Pass an idempotency key, such as `id()` inside the step, and put job-to-actor calls that must not repeat inside a step or make the receiving command idempotent.
</Warning>

## Job broadcasts

Broadcasts sent by a command are published after the command is durable. Broadcasts sent by a job are published immediately and can repeat after a retry. Neither is retained, so save final results through a command.

See [Jobs](../api/jobs.md) for retries, durable sleep, and failure delivery, and the [background-work contract](https://github.com/Rika-Labs/akter/blob/main/docs/contracts/08-background-work.md) for the guarantees.
