import { Config, Context, Effect, Layer, Redacted } from "effect"
import { describe, expect, it } from "vitest"
import { NekiTurnSessions } from "./session.ts"
import { TurnConnections, turnConnections } from "../../turn/pipeline.ts"

/** The session settings a turn's connection reports on each of two leases. */
const sessionSettings = (neki: boolean) =>
  Effect.gen(function* () {
    const url = yield* Config.String("TEST_DATABASE_URL")

    const context = yield* Layer.build(
      turnConnections({ url: Redacted.make(url), maxConnections: 1 }).pipe(
        Layer.provide(Layer.succeed(NekiTurnSessions, neki)),
      ),
    )

    const { lease } = Context.get(context, TurnConnections)

    const read = Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* lease

        const [row] = yield* connection.queryValues(
          "SELECT current_setting('__neki.tx_mode', true), current_setting('__neki.fanout', true)",
        )

        return { pid: connection.processId, mode: row![0], fanout: row![1] }
      }),
    )

    return [yield* read, yield* read]
  }).pipe(Effect.scoped)

describe("turn connections on Neki", () => {
  it("sets single transaction mode and single fanout on the session before a turn leases it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const [first, second] = yield* sessionSettings(true)

        expect(first).toMatchObject({ mode: "single", fanout: "single" })
        expect(second).toEqual(first)
      }).pipe(Effect.orDie),
    ))

  it("leaves the session as the server has it when the database is not Neki", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const [first] = yield* sessionSettings(false)

        expect(first).toMatchObject({ mode: null, fanout: null })
      }).pipe(Effect.orDie),
    ))
})
