---
title: "Testing"
description: "Test actors with the seeded Simulation, and check real buckets with akter storage check."
---

# Testing

Test the durable behavior of your actors, not only the happy path. `Simulation` from `@rikalabs/akter/testing` runs the real engine over a seeded in-memory bucket with controlled time, scheduling, and faults.

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
