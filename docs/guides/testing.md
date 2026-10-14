---
title: "Testing"
description: "Use seeded Simulation for action failures and real buckets for provider behavior."
---

# Testing

Name the wrong implementation a test must reject before writing it. Use asymmetric inputs and independently derived expectations; success-only examples do not prove discard or recovery.

## A public-API simulation

```ts
import assert from "node:assert/strict"
import { Effect } from "effect"
import { Simulation } from "@rikalabs/akter/testing"
import { Counter, CounterLive } from "../counter.ts"

await Simulation.run(
  { actors: [Counter], seed: 41 },
  Effect.gen(function* () {
    const counter = yield* Counter.client("test-counter")
    assert.equal(yield* counter.add(3), 3)
    yield* Simulation.settle
    assert.equal((yield* Simulation.state(Counter, "test-counter")).count, 3)
  }).pipe(Effect.scoped),
  CounterLive,
)
```

`Simulation` runs the engine over a seeded bucket with controlled time, scheduling, and faults. It can settle pending work, inspect full state including lists, and exercise interruption and replay. The seed identifies the failing schedule; retain it when reducing a failure.

## Failure evidence

Exercise declared failure and defect discard, a lost append, page misses, owner loss, retry with the same command id, restart, interrupted checkpoints, and ambiguous external steps. Assert resulting durable state and obligations, not just that execution returned. Double-run determinism and replay compare outcomes, while bucket suites validate create-once, CAS, listing, and page hashes.

The repository uses MinIO for S3-compatible integration evidence on Bun and Node. Filesystem, simulator, and MinIO runs do not validate R2, Tigris, AWS S3, or power-loss behavior. Provider support needs an actual `akter storage check` record. See [verification](https://github.com/Rika-Labs/akter/blob/main/docs/verification/README.md) for current scenarios and limits.
