import { BunCrypto } from "@effect/platform-bun"
import { Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import { SqlError } from "effect/sql"
import { afterAll, describe, expect, it } from "vitest"
import { Actor } from "../../index.ts"
import { ActorTest } from "../../testing/actor-test.ts"
import { TurnHooks } from "../turn/hooks.ts"
import { transientSqlError } from "./transient.ts"

const serverError = (code: string) =>
  SqlError.SqlError.make({
    reason: SqlError.UnknownError.make({
      cause: Object.assign(new Error(`server said ${code}`), { code }),
      message: "PgConnection: Failed to connect",
      operation: "connect",
    }),
  })

const Add = Actor.command("Add", { payload: Schema.Int, success: Schema.Int })

const Tally = Actor.make("TransientTally", {
  key: Schema.String,
  state: Actor.state({ total: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Add },
})

const runs = { adds: 0 }

/** The next turn to reach `beforeCommit` dies with this error, once. */
let pending: SqlError.SqlError | undefined

const runtime = ManagedRuntime.make(
  Tally.toLayer(
    Effect.succeed({
      Add: Effect.fnUntraced(function* (amount: number) {
        runs.adds += 1
        const turn = yield* Tally.Turn
        yield* turn.state.set({ total: turn.state.total + amount })

        return turn.state.total
      }),
    }),
  ).pipe(
    Layer.provideMerge(ActorTest.layer({})),
    Layer.provide(
      Layer.succeed(TurnHooks, {
        at: (point) => {
          const error = pending
          if (point !== "beforeCommit" || error === undefined) return Effect.void
          pending = undefined

          return Effect.die(error)
        },
      }),
    ),
    Layer.provide(BunCrypto.layer),
  ),
)

afterAll(() => runtime.dispose())

describe("transient SQL errors", () => {
  it("treats server shutdown, startup and exhaustion as transient, and statement errors as not", () => {
    expect(transientSqlError(serverError("57P01"))).toBe(true)
    expect(transientSqlError(serverError("57P02"))).toBe(true)
    expect(transientSqlError(serverError("57P03"))).toBe(true)
    expect(transientSqlError(serverError("53300"))).toBe(true)
    expect(transientSqlError(serverError("53000"))).toBe(true)
    expect(transientSqlError(serverError("53100"))).toBe(true)
    expect(transientSqlError(serverError("53200"))).toBe(true)
    expect(transientSqlError(serverError("22P02"))).toBe(false)
    expect(transientSqlError(serverError("XX000"))).toBe(false)
    expect(transientSqlError(serverError("57P04"))).toBe(false)
    expect(transientSqlError(serverError("57P05"))).toBe(false)
    expect(transientSqlError(serverError("53400"))).toBe(false)
    expect(transientSqlError(serverError("53"))).toBe(false)
    expect(
      transientSqlError(
        SqlError.SqlError.make({
          reason: SqlError.ConnectionError.make({ cause: new Error("reset"), message: "reset" }),
        }),
      ),
    ).toBe(true)
  })

  it("retries a turn the server refused while shutting down and commits it once", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const tally = yield* Tally.get("shutdown")
        const before = runs.adds
        pending = serverError("57P01")

        expect(yield* tally.Add(5)).toBe(5)
        expect(pending).toBeUndefined()
        expect(runs.adds - before).toBe(2)
        expect(yield* test.inspect(tally.ref)).toMatchObject({ state: { total: 5 }, receipts: 1 })
      }),
    ))

  it("answers a statement error as a defect without retrying it", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const tally = yield* Tally.get("statement")
        const before = runs.adds
        pending = serverError("22P02")

        const exit = yield* Effect.exit(tally.Add(5))

        expect(Exit.isFailure(exit)).toBe(true)
        expect(runs.adds - before).toBe(1)
        expect(yield* test.inspect(tally.ref)).toMatchObject({ state: {}, receipts: 0 })
      }),
    ))
})
