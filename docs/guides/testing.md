# Testing

`@rikalabs/akter/testing` has two tools, for two kinds of question.

- **`Story`** asks "does this handler make the right decision?" It runs one actor's command and view handlers as plain functions, with no engine, no store and no Effect runtime.
- **`Simulation`** asks "does the system do the right thing?" It runs the real engine over an in-memory bucket, on a seeded scheduler, and can crash servers and lose writes on purpose.

Both work in `bun test`, Vitest and `node:test`. The examples here use the `Account` actor from [Commands](../core/commands.md) and the `Signup` actor from [Jobs](../core/jobs.md).

## Story

A story sets up a state, runs commands, and checks what each one did:

```ts
import { expect, test } from "bun:test"
import { Story } from "@rikalabs/akter/testing"
import { Account, AccountLive, InsufficientFunds } from "./account.ts"

test("withdraw refuses to overdraw and changes nothing", () => {
  Story.run(
    Account,
    AccountLive,
    Story.given({ balance: 50 }),
    Story.command("withdraw", 80),
    Story.expectFailure(InsufficientFunds),
    Story.state((state) => expect(state.balance).toBe(50)),
    Story.command("withdraw", 30),
    Story.expectReply(20),
  )
})
```

A failed command is thrown away exactly as it would be in production, so the next step sees the state from before it. Every step is type-checked against the actor: command names, payloads, replies, errors and state fields. When a check fails, `Story.run` throws a `StoryFailure` that names the step and shows what the command actually did.

The steps:

| Step                                                        | What it does                                                      |
| ----------------------------------------------------------- | ----------------------------------------------------------------- |
| `Story.given(state, { self })`                              | Sets the starting state, including list items, and the actor's id |
| `Story.command(name, payload, { caller, now, id, random })` | Runs a command, public or internal; the options fix its context   |
| `Story.expectReply(value)`                                  | Checks the reply                                                  |
| `Story.expectFailure(ErrorClass)`                           | Checks the declared error                                         |
| `Story.expectDefect({ kind, detail })`                      | Checks that the handler threw or broke a rule                     |
| `Story.expectSent(Actor, id, command, payload)`             | Checks a `send`                                                   |
| `Story.expectScheduled(when, command, payload)`             | Checks a timer                                                    |
| `Story.expectStarted(job, payload, { key })`                | Checks a job start                                                |
| `Story.expectBroadcast(name, value)`                        | Checks a broadcast                                                |
| `Story.expectNothingStaged()`                               | Fails if anything staged hasn't been checked                      |
| `Story.state(check)`                                        | Passes the current state, with lists as arrays, to your check     |
| `Story.view(name, params, check)`                           | Passes a view's value to your check                               |

A failure or defect must be checked before the next command, so a story can't ignore one by accident.

A story never runs a job. To test what happens when a job finishes, run the command that receives its result, such as `Story.command("failedSendWelcome", failure)`. If your jobs need services, provide stubs to the layer you pass in; a story only reads the handlers from it.

`Story.effect` runs the same steps as an Effect, for test runners built on Effect.

## Simulation

A simulation drives the actor through its client, the way your app will:

```ts
import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Simulation } from "@rikalabs/akter/testing"
import { Mailer, Signup, SignupLive } from "./signup.ts"

test("the welcome email goes out once, through crashes and lost writes", async () => {
  const keys = new Set<string>()
  const mailer = Layer.succeed(Mailer, {
    send: ({ idempotencyKey }) =>
      Effect.sync(() => {
        keys.add(idempotencyKey)
        return "message-1"
      }),
  })

  await Simulation.run(
    { actors: [Signup], seed: 7, faults: ["crash", "lostResponse", "unavailable"] },
    Effect.gen(function* () {
      const signup = yield* Signup.client("ada")
      yield* signup.register("ada@example.com")
      yield* Simulation.settle
      const state = yield* Simulation.state(Signup, "ada")
      expect(state.welcome).toBe("sent")
      expect(keys.size).toBe(1)
    }).pipe(Effect.scoped),
    SignupLive.pipe(Layer.provide(mailer)),
  )
})
```

`Simulation.run` takes the options, the test program, and the actors' layer with every service provided. Inside the program:

- `Simulation.settle` runs until there's nothing left to do: no pending commands, sends, timers or jobs.
- `Simulation.state(Actor, id)` reads what's actually stored, lists included.
- `Simulation.advance("1 hour")` moves the clock forward, firing timers, cron ticks and retries as they come due.
- `Simulation.crash(Actor, id)` crashes the server that owns an actor. Its memory is gone, and it recovers from the bucket.
- `Simulation.as(caller)` runs part of the program as another caller.

The clock is simulated, so an hour passes instantly.

## Faults

`faults` turns on failures between the engine and the bucket:

| Fault          | What happens                                                   |
| -------------- | -------------------------------------------------------------- |
| `crash`        | The server crashes just before or just after a log write lands |
| `lostResponse` | A write succeeds but the server never hears back               |
| `unavailable`  | The bucket fails requests for a while                          |
| `slowLog`      | Writes are delayed while other work goes on                    |

These are the failures that break naive backends: the reply that was sent for a write that was lost, the retry that ran twice. A test that passes with faults on shows your actors behave correctly through them.

## Seeds

Everything in a simulation, including the order in which concurrent work runs and where faults strike, follows from `seed`. The same seed replays the same run, so a failure is always reproducible. Run a test over many seeds to cover more interleavings:

```ts
for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) test(`seed ${seed}`, () => run(seed))
```

## What the simulation checks for you

When it settles, a simulation also checks Akter's own guarantees and fails with an `InvariantViolation` that names the seed. Among other things, it runs every command twice against a copy of the state and compares the results, which catches a handler that isn't [deterministic](../core/commands.md#stay-deterministic). A handler that reads `Date.now()` fails here rather than in production.

## What to test

Before writing a test, think of the wrong implementation it should catch. A test that only checks the happy path can't tell you whether a failure is really thrown away. Cover the cases that matter for state that has to survive:

- A declared failure and a thrown error, with the state unchanged afterward.
- A retry with the same command id.
- A job step that fails, and one that crashes partway.
- A crash, followed by recovery.

Assert on what's stored with `Simulation.state`, not only on what a call returned.

## Testing a real bucket

A simulation uses an in-memory bucket, and the filesystem store is for one machine. Neither tells you how your storage provider behaves. Before you deploy, run [`akter storage check`](../reference/cli.md#akter-storage-check) against the bucket you'll use. See [Deploying](../deploy/overview.md).
