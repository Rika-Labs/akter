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
import { outboxRelay, type RelaySettings } from "./relay.ts"

const ROWS = 300

const settings: RelaySettings = {
  pollMs: 1000,
  passLimit: 256,
  deliveryConcurrency: 16,
  claimLeaseMs: () => 37_000,
  maxBackoffMs: 256_000,
  executorConcurrency: 64,
  executorLeaseMs: 60_000,
}

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

// Rows still due now; a claimed row is not due until its lease ends.
const due = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  return (yield* sql<{ count: number }>`SELECT count(*)::int AS count FROM actor_outbox
    WHERE due_at_ms <= (extract(epoch FROM clock_timestamp()) * 1000)::bigint`)[0]!.count
})

// The poll timeout runs on TestClock and never fires, so every claim after the first comes from
// a freed delivery slot while the backlog lasts.
const runRelay = () =>
  Effect.gen(function* () {
    yield* seed
    const delivered: Array<Request> = []

    const relay = yield* outboxRelay(
      (request) =>
        Effect.sync(() => {
          delivered.push(request)

          return Outcome.cases.Success.make({ value: "{}" })
        }),
      () => [],
      settings,
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

    return {
      delivered: delivered.length,
      distinct: new Set(delivered.map(({ commandId }) => commandId)).size,
      pending: yield* pending,
      due: yield* due,
    }
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
    (runtime) => Effect.promise(() => runtime.runPromise(Effect.scoped(runRelay()))),
    (runtime) => Effect.promise(() => runtime.dispose()),
  )

describe("outbox relay loop", () => {
  it("claims again as each delivery slot frees while more rows are due", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* measureRelay({ failDelete: false })).toEqual({
          delivered: ROWS,
          distinct: ROWS,
          pending: 0,
          due: 0,
        })
      }),
    ))

  it("keeps rows whose settle died out of claims until their lease ends", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // Every row is delivered once and dies before its delete; none is due again, so none
        // is redelivered and the rows behind them are still reached.
        expect(yield* measureRelay({ failDelete: true })).toEqual({
          delivered: ROWS,
          distinct: ROWS,
          pending: ROWS,
          due: 0,
        })
      }),
    ))
})
