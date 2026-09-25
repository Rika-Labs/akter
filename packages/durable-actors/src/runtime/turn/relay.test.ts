import { BunCrypto } from "@effect/platform-bun"
import { Effect, Fiber, Layer, ManagedRuntime, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { Outcome, type Request } from "../../handles/actors.ts"
import { System } from "../../identity/caller.ts"
import { migrate } from "../database/migrations.ts"
import { Database } from "../layer.ts"
import { RetryTurn, TurnHooks } from "./hooks.ts"
import { CallerJson } from "./outbox.ts"
import { outboxRelay, PASS_LIMIT } from "./relay.ts"

const ROWS = PASS_LIMIT + 44

// Every row is due at epoch 0 and belongs to one sender, so one bucket holds the backlog.
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* migrate

  const caller = yield* Schema.encodeEffect(CallerJson)(System.make({ source: "actor" }))

  yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
    VALUES (1, 't', 'Sender', 's')`
  yield* sql`INSERT INTO actor_outbox (routing_key, intent_id, bucket, due_at_ms, tenant_id,
      actor_type, actor_id, target_type, target_id, command, payload, caller)
    SELECT 1, 'intent-' || i, 0, 0, 't', 'Sender', 's', 'Sink', 'sink', 'Deliver', '{}', ${caller}
    FROM generate_series(1, ${ROWS}::int) AS i`
})

const pending = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  return (yield* sql<{ count: number }>`SELECT count(*)::int AS count FROM actor_outbox`)[0]!.count
})

// The poll timeout runs on TestClock and never fires, so every pass after the first comes from
// the backlog path alone.
const runRelay = () =>
  Effect.gen(function* () {
    yield* seed
    const delivered: Array<Request> = []

    const relay = yield* outboxRelay((request) =>
      Effect.sync(() => {
        delivered.push(request)

        return Outcome.cases.Success.make({ value: "{}" })
      }),
    )

    const fiber = yield* relay.run.pipe(Effect.forkChild)
    yield* relay.wake

    // Lets the relay run until it settles or starts waiting; real time, not the TestClock.
    let previous = -1

    while (delivered.length !== previous) {
      previous = delivered.length
      yield* TestClock.withLive(Effect.sleep("300 millis"))
    }

    yield* Fiber.interrupt(fiber)

    return { delivered: delivered.length, pending: yield* pending }
  })

const relayLayer = (options: { readonly failDelete: boolean }) =>
  Layer.mergeAll(
    Database.pglite(),
    BunCrypto.layer,
    TestClock.layer(),
    Layer.succeed(TurnHooks, {
      at: (point) =>
        options.failDelete && point === "beforeOutboxDelete"
          ? Effect.die(RetryTurn.make({ message: "Injected beforeOutboxDelete crash" }))
          : Effect.void,
    }),
  )

const measureRelay = (options: { readonly failDelete: boolean }) =>
  Effect.acquireUseRelease(
    Effect.sync(() => ManagedRuntime.make(relayLayer(options))),
    (runtime) => Effect.promise(() => runtime.runPromise(runRelay())),
    (runtime) => Effect.promise(() => runtime.dispose()),
  )

describe("outbox relay loop", () => {
  it("runs the next pass at once after a full pass that settled every row", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* measureRelay({ failDelete: false })).toEqual({ delivered: ROWS, pending: 0 })
      }),
    ))

  it("waits for the poll instead of spinning when rows die before they settle", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // One full pass delivers the first rows, none settle, and the loop waits: no second pass.
        expect(yield* measureRelay({ failDelete: true })).toEqual({
          delivered: PASS_LIMIT,
          pending: ROWS,
        })
      }),
    ))
})
