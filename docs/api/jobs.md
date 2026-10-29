---
title: "Jobs"
description: "Run I/O as journaled Effects: steps, retries, failure delivery, and durable sleep."
---

# Jobs

A job runs I/O as an Effect, in the same `toLayer` as the actor's synchronous commands. Declare it with `Actor.job` and start it from a command with `ctx.start.<name>(payload, { key? })`.

## Declare a job

`Actor.job({ payload?, retry?, timeout?, concurrency?, onFailure })`

| Option        | Default                       | Meaning                                           |
| ------------- | ----------------------------- | ------------------------------------------------- |
| `payload`     | none                          | Schema of the job's input                         |
| `retry`       | `{ attempts: 1, backoff: 0 }` | Total attempts and the wait between them          |
| `timeout`     | none                          | Longest an attempt may run                        |
| `concurrency` | `1`                           | How many runs of this job may be active at once   |
| `onFailure`   | required                      | An internal command that takes `Actor.JobFailure` |

No cancellation, compensation, or workflow-run handle is exposed.

## Write the handler

```ts
import { Context, Effect, Schema, Stream } from "effect"
import { Actor } from "@rikalabs/akter"
import { DurableClock } from "@rikalabs/akter/server"

class Model extends Context.Service<Model, { stream(prompt: string): Stream.Stream<string> }>()(
  "Model",
) {}

const Chat = Actor.make("Chat", {
  state: Schema.Struct({
    answer: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  }),
  commands: {
    ask: Actor.command(Schema.String),
    save: Actor.command(Schema.String, { internal: true }),
    failed: Actor.command(Actor.JobFailure, { internal: true }),
  },
  broadcasts: { token: Actor.broadcast(Schema.String) },
  jobs: {
    generate: Actor.job({
      payload: Schema.String,
      retry: { attempts: 3, backoff: "2 seconds" },
      onFailure: "failed",
    }),
  },
})

const ChatLive = Chat.toLayer({
  ask: (_chat, prompt, ctx) => {
    ctx.start.generate(prompt)
  },
  save: (chat, text) => {
    chat.answer = text
  },
  failed: (chat) => {
    chat.answer = "Something went wrong."
  },
  generate: (prompt, { self, step, broadcast }) =>
    Effect.gen(function* () {
      const model = yield* Model
      const text = yield* step(
        "generate",
        model.stream(prompt).pipe(
          Stream.tap((token) => broadcast.token(token)),
          Stream.runFold(
            () => "",
            (all, token) => all + token,
          ),
        ),
      )
      yield* step("save", self.save(text))
      yield* DurableClock.sleep({ name: "cooldown", duration: "10 seconds" })
    }),
})
```

The handler receives the payload and `{ self, step, broadcast, id, attempt }`. `attempt` starts at 1. Services the handler needs flow into the type of `toLayer`.

## Steps

`step(name, effect)` records a JSON-encodable or void result. Use `step(name, schema, effect)` for a value JSON cannot hold, such as a bigint or a class instance. The schema must not require services.

- Step names must be unique within the job, nonempty, not `body`, and free of NUL.
- Once a step's success is durable, it never runs again, even when a later step causes a new attempt.
- A failed or interrupted step may repeat external I/O, so pass an idempotency key. `id()` inside a step is stable for that job, step, and call position across retries.

Calls from a job to an actor get ids derived from the job, the step (or `body`), the attempt, and the call's position. A crash replay keeps the attempt and returns the receiver's stored outcome. A deliberate retry gets fresh ids, so put calls that must not repeat inside a step, or make the receiving command idempotent. Calls in one scope run in sequence. Parallel calls need separate steps.

## When retries run out

`onFailure` receives `{ job, declaration, key?, payload, attempts, cause, ambiguous }` once. `payload` is in its encoded form. `cause` is `Failed`, `Defect`, or `Timeout`. `ambiguous` is true when a step was running and may already have reached its provider. A typed step failure clears the ambiguity. A crash during failure delivery retries with the same derived command id and keeps the recorded cause.

## Durable sleep

`DurableClock.sleep({ name, duration })` journals the deadline, so it survives a restart or an owner change and counts toward the `nextDue` in the drain report. `Effect.sleep` is a local wait that restarts with the handler.

## Broadcasts from jobs

A broadcast sent from a job is published immediately and can repeat after a retry. It is not stored. Save final results through an actor call, as the example does with `save`.

## With several runners

With `Akter.serve({ runner })`, job calls go to the receiver's shard owner over mutual TLS and keep their derived command ids and the original caller. A job finishes only after every receiver's call stream for it is durably retired. If an owner moves, the cleanup resumes without rerunning completed steps.

See the [background-work contract](https://github.com/Rika-Labs/akter/blob/main/docs/contracts/08-background-work.md) for the guarantees and the [job evidence](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e5-jobs.md) for the failure scenarios and provider limits.
