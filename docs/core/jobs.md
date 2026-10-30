# Jobs

A job does the I/O a command can't: sending email, charging a card, calling a model. A command starts it, and Akter runs it after the command is stored. A job is an Effect, and each named step's result is recorded, so a job that fails or crashes halfway resumes without repeating the steps that finished.

## Start a job

This actor registers an email address and sends a welcome email:

```ts
import { Context, Effect, Schedule, Schema } from "effect"
import { Actor, Job } from "@rikalabs/akter"

export class Mailer extends Context.Service<
  Mailer,
  { send(email: { to: string; idempotencyKey: string }): Effect.Effect<string> }
>()("Mailer") {}

export const Signup = Actor.make("Signup", {
  state: Schema.Struct({
    email: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    welcome: Schema.Literals(["pending", "sent", "failed"]).pipe(
      Schema.withDecodingDefault(Effect.succeed("pending" as const)),
    ),
  }),
  commands: {
    register: Actor.command(Schema.String),
    succeededSendWelcome: Actor.command(Schema.String, { internal: true }),
    failedSendWelcome: Actor.command(Actor.JobFailure, { internal: true }),
  },
  jobs: {
    sendWelcome: Actor.job({
      payload: Schema.String,
      onSuccess: "succeededSendWelcome",
      onFailure: "failedSendWelcome",
    }).pipe(
      Job.retry({ times: 3, schedule: Schedule.exponential("1 second") }),
      Job.timeout("30 seconds"),
    ),
  },
})

export const SignupLive = Signup.toLayer({
  register: (signup, email, { start }) => {
    signup.email = email
    start.sendWelcome(email)
  },
  sendWelcome: (email, { step, id }) =>
    Effect.gen(function* () {
      const mailer = yield* Mailer
      return yield* step(
        "send",
        Effect.suspend(() => mailer.send({ to: email, idempotencyKey: id() })),
      )
    }),
  succeededSendWelcome: (signup) => {
    signup.welcome = "sent"
  },
  failedSendWelcome: (signup) => {
    signup.welcome = "failed"
  },
})
```

`register` stores the email and stages the job with `start.sendWelcome(email)`. The job starts once `register` is stored. If `register` had failed, the job would never start.

The job handler gets its payload and a context, and returns an Effect. It can use any Effect service. `Mailer` shows up in `SignupLive`'s requirements, and you provide it when you build the app:

```ts
App.make({ actors: [Signup], layer: SignupLive.pipe(Layer.provide(MailerLive)) })
```

## Steps

`step(name, effect)` runs an effect once and records its result. If the job runs again, after a retry or after a crash, a step whose result is recorded returns that result without running.

```ts
const charge = yield * step("charge", payments.charge(order))
yield * step("receipt", mailer.send(receiptFor(charge)))
```

If `receipt` fails and the job retries, `charge` isn't charged again. Its recorded result is reused.

Step names must be unique within a job. A step's result must be JSON, or nothing. For other values, pass a schema: `step("total", Schema.BigInt, effect)`.

## Idempotency keys

A step that was running when the server crashed has no recorded result, so it runs again. The provider may have already received the first request. Akter can't know, and neither can any other framework.

The fix is the provider's idempotency key. Inside a step, `id()` returns a key that stays the same for that job, step and position across every retry, so the provider can recognize the repeat. Call `id()` inside the step's effect, as `Effect.suspend` does above.

## Results

A job ends in one of two ways.

When it succeeds, the value its Effect returns is recorded, then delivered once to the command named by `onSuccess`. That command's payload schema must match what the job returns. A job without `onSuccess` just ends.

When its last attempt fails, the command named by `onFailure` receives an `Actor.JobFailure`:

| Field         | Meaning                                                        |
| ------------- | -------------------------------------------------------------- |
| `job`         | The job's id                                                   |
| `declaration` | The job's name, such as `sendWelcome`                          |
| `key`         | The job's key, if it was started with one                      |
| `payload`     | The job's payload, encoded                                     |
| `attempts`    | How many attempts ran                                          |
| `cause`       | `Failed`, `Defect` or `Timeout`                                |
| `ambiguous`   | `true` if a step was running and may have reached its provider |

Both commands must be internal commands of the same actor, and `onFailure` is required. Name them as facts, `succeeded<Job>` and `failed<Job>`, and let them decide what the actor does next.

## Retries and timeouts

A job makes one attempt unless you pipe it through policies:

- `Job.retry({ times, schedule })` retries a failed attempt up to `times` more times. `schedule` is an Effect `Schedule` that sets the wait before each retry; `Schedule.exponential("1 second")` waits 1, 2, then 4 seconds. A schedule that ends stops the retries early.
- `Job.timeout(duration)` fails an attempt that runs longer than `duration`.

Each wait is computed once, when the failure is recorded. If the server restarts during the wait, the retry still happens at the original time.

## Wait for a while

`Effect.sleep` in a job is an ordinary in-memory wait: if the server restarts, the job starts the wait over. `DurableClock.sleep`, from `@rikalabs/akter/server`, records when the wait ends, so it survives a restart and a move to another server:

```ts
yield * DurableClock.sleep({ name: "cool-down", duration: "1 hour" })
```

## Call actors

A job can call commands, including internal ones, on its own actor through `self`, and on any actor through its client:

```ts
reserve: ({ sku, quantity }, { self, step }) =>
  Effect.gen(function* () {
    const stock = yield* Stock.client(sku)
    yield* step("reserve", stock.reserve(quantity))
    yield* self.markReserved()
  }).pipe(Effect.scoped),
```

Calls from a job get command ids derived from the job, so replaying the job after a crash doesn't run them twice. A retry is a new attempt and gets new ids, so put a call that must never repeat inside a step, as `reserve` is here.

## Keys and concurrency

`start.sendWelcome(email, { key: email })` gives the job a key. Only one job with a given key can be open at a time for each actor and job; starting another while one is open does nothing. Without a key, every start is a new job.

`Actor.job({ concurrency: 3, ... })` lets up to three runs of that job be active at once in each [shard](../deploy/overview.md#shards). The default is one. Jobs that are waiting start in the order they were started.

## Progress

A job can send [broadcasts](realtime.md#broadcasts) with its context's `broadcast`, to stream progress such as tokens from a model. A broadcast from a job goes out immediately and may be repeated if the job retries. Use `onSuccess` or a command for anything that needs to be kept.

## No cancellation

Once a job starts, it runs until it succeeds or its retries run out. There's no cancel. If a job might become unnecessary, have it check its actor's state in an early step and end quietly.
