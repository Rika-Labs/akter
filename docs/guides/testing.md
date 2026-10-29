---
title: "Testing"
description: "Test handlers with Story, test actors with the seeded Simulation, and check real buckets with akter storage check."
---

# Testing

Test the durable behavior of your actors, not only the happy path. `@rikalabs/akter/testing` has two tools. `Story` runs one actor's command and view handlers as plain functions. `Simulation` runs the real engine over a seeded in-memory bucket with controlled time, scheduling, and faults.

## Test handlers with Story

A story gives an actor a starting state, runs commands, and checks the reply or failure, the new state, and everything the command staged. It runs synchronously, with no engine, no store, and no Effect runtime, so it works in vitest, bun test, and node:test.

```ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { Story } from "@rikalabs/akter/testing"
import { Counter, CounterLive, TooLarge } from "./counter.ts"

test("add refuses to pass 100 and keeps the count", () => {
  Story.run(
    Counter,
    CounterLive,
    Story.given({ count: 99 }),
    Story.command("add", 2),
    Story.expectFailure(TooLarge),
    Story.state((state) => assert.equal(state.count, 99)),
    Story.expectNothingStaged(),
  )
})
```

Each step is checked against the contract at compile time: command names and payloads, replies, failures, state fields, job and broadcast names and their values. When an expectation fails, `Story.run` throws a `StoryFailure` that names the step and shows what the command actually did. `Story.effect` runs the same steps as an Effect that fails with the `StoryFailure`.

A command runs through the engine's own command runner. A declared failure or a thrown error discards the draft and everything the command staged, exactly as in production, and the next steps see the state from before the command. A failure or defect must be checked with `Story.expectFailure` or `Story.expectDefect` before the next command, or the story fails. Steps after a successful command see its new state.

The steps:

- `Story.given(state, { self? })` sets scalar fields and gives each list its items. `self` is the instance id handlers see as `ctx.self`; it defaults to `"story"`.
- `Story.command(name, payload?, { caller?, now?, id?, random? })` runs a public or internal command. `caller` defaults to `System({ source: "process", subject: "process" })`, the caller `Simulation` uses, and `now` defaults to `0`. `id` and `random` list the values `ctx.id()` and `ctx.random()` return, in order; drawing more than you listed fails the story. Without them, the handler gets the engine's values, derived from the story's own command ids, which are the same on every run.
- `Story.expectReply(value)`, `Story.expectFailure(ErrorClass or value)` and `Story.expectDefect({ kind?, detail? })` check how the last command ended.
- `Story.expectSent(Target, id, command, payload?)`, `Story.expectScheduled(when, command, payload?)`, `Story.expectStarted(job, payload?, { key? })` and `Story.expectBroadcast(name, value)` each match one item the last command staged. `Story.expectNothingStaged()` fails if anything staged is still unmatched.
- `Story.state((state) => ...)` passes the current state to your check, with each list as an array in `by` order. `Story.view(name, params?, (value) => ...)` reads a view.

A story never runs a job. To test what happens when a job finishes, run the internal command that receives its result, such as `Story.command("failedReport", failure)`. Internal commands can be called in a story, and they get a `System` caller.

`Story.run` takes the layer from `toLayer` only to read its handlers. If your jobs need services, provide them to that layer, as `Simulation.run` requires. Stubs are fine, because a story never runs a job. A story does not check `access`.

### Story or Simulation

Use `Story` for the decisions a handler makes: replies, failures, state changes, and staged sends, timers, job starts, and broadcasts. Use `Simulation` for anything the engine does: durability, retries, delivery between actors, timers firing, jobs running, crashes, and recovery.

## Write a simulation test

```ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import { Simulation } from "@rikalabs/akter/testing"
import { Counter, CounterLive, TooLarge } from "./counter.ts"

test("a declared failure leaves the state unchanged", async () => {
  await Simulation.run(
    { actors: [Counter], seed: 41 },
    Effect.gen(function* () {
      const counter = yield* Counter.client("test")
      assert.equal(yield* counter.add(60), 60)
      const failure = yield* Effect.flip(counter.add(70))
      assert.ok(failure instanceof TooLarge)
      yield* Simulation.settle
      assert.equal((yield* Simulation.state(Counter, "test")).count, 60)
    }).pipe(Effect.scoped),
    CounterLive,
  )
})
```

This test uses the `add` command from [Commands and jobs](./actions-and-jobs.md), with `TooLarge` exported. It calls the actor through the public client, waits for pending work with `Simulation.settle`, and reads the full durable state, including lists, with `Simulation.state`.

The `seed` makes the run repeatable. When a run breaks an invariant, the error names its seed, so keep it when you reduce the failure.

## What to test

Before you write a test, name the wrong implementation it must reject. Use inputs that differ from each other and expected values you derived independently. A success-only test cannot show that a discard or recovery works.

Cover the cases where durability matters:

- A declared failure and a defect, with the state unchanged.
- A lost or ambiguous write, owner loss, and restart.
- A retry with the same command id.
- An interrupted job step.

Assert the resulting durable state, not only that the call returned. Pass `faults` to `Simulation.run` to inject crashes, lost responses, outages, and slow writes between the store and the bucket.

## Test a real bucket

The simulator and the filesystem store do not validate a provider. The repository's own integration tests use MinIO. None of these show how your provider behaves under load or power loss.

Run [`akter storage check`](../api/06-cli.md#akter-storage-check) against the bucket you plan to use, and keep its output. See [Deploy](./deploy.md).
